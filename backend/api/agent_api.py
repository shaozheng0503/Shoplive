import os
import re
import json
import html
import logging
import threading
import time
import base64
from urllib.parse import urljoin, urlparse
from typing import Callable, Dict, Tuple
from pathlib import Path

logger = logging.getLogger(__name__)

import requests
from flask import Response, g, jsonify, request, stream_with_context
from shoplive.backend.async_executor import get_executor

from shoplive.backend.audit import audit_log
from shoplive.backend.async_executor import make_cache_key, product_insight_cache

# Per-URL in-flight events: prevents concurrent requests for the same product URL
# from each launching a full scrape + LLM analysis independently.
_insight_inflight: dict = {}
_insight_inflight_lock = threading.Lock()


def _cleanup_inflight_key(cache_key: str) -> None:
    """Signal and remove an in-flight entry so waiting threads unblock."""
    with _insight_inflight_lock:
        ev = _insight_inflight.pop(cache_key, None)
    if ev:
        ev.set()


# Maximum number of messages kept in /api/agent/run history (system prompt + N-1).
# Prevents unbounded context growth in long multi-tool sessions.
# Override via AGENT_MAX_HISTORY env var.
import os as _os
AGENT_MAX_HISTORY: int = int(_os.getenv("AGENT_MAX_HISTORY", "60"))
from shoplive.backend.validation import validate_request
from shoplive.backend.schemas import (
    AgentChatRequest,
    AgentRunRequest,
    ImageInsightRequest,
    ProductInsightRequest,
)

# ---------------------------------------------------------------------------
# Module-level constants & helpers for the agentic loop
# ---------------------------------------------------------------------------

_DEFAULT_AGENT_TOOLS = ["export_edited_video", "render_video_timeline"]
_ALL_AGENT_TOOL_NAMES = [
    "parse_product_url", "analyze_product_image", "run_video_workflow",
    "generate_video", "chain_video_segments", "check_video_status", "extend_video",
    "export_edited_video", "render_video_timeline", "generate_product_image",
]
_TOOL_ENDPOINT_MAP = {
    "parse_product_url":     ("api_agent_shop_product_insight", "/api/agent/shop-product-insight"),
    "analyze_product_image": ("api_agent_image_insight",        "/api/agent/image-insight"),
    "run_video_workflow":    ("api_shoplive_video_workflow",     "/api/shoplive/video/workflow"),
    "generate_video":        ("api_veo_start",                  "/api/veo/start"),
    "chain_video_segments":  ("api_veo_chain",                  "/api/veo/chain"),
    "check_video_status":    ("api_veo_status",                 "/api/veo/status"),
    "extend_video":          ("api_veo_extend",                 "/api/veo/extend"),
    "export_edited_video":   ("api_video_edit_export",          "/api/video/edit/export"),
    "render_video_timeline": ("api_video_timeline_render",      "/api/video/timeline/render"),
    "generate_product_image":("api_shoplive_image_generate",    "/api/shoplive/image/generate"),
}

_AMAZON_STRONG_MATCH_PRESETS = {
    "B0CZDHS41T": {
        "canonical_url": "https://www.amazon.com/dp/B0CZDHS41T",
        "product_name": "Soundcore Space One (FlexiCurve) Over-Ear Headphones - White",
        "main_business": "消费电子耳机",
        "style_template": "clean",
        "selling_points": [
            "白色外观，简洁高级，适合电商视觉展示",
            "头戴式舒适贴合，适合长时间佩戴",
            "突出降噪与沉浸式听感场景",
        ],
        "target_user": "通勤与日常影音用户",
        "sales_region": "北美",
        "brand_direction": "科技感、简洁、质感",
        "product_anchors": {
            "category": "头戴式耳机",
            "colors": ["白色"],
            "materials": ["塑料", "金属"],
            "silhouette": "包耳式头戴耳机",
            "must_keep": ["白色机身", "头梁结构", "耳罩形态", "Soundcore 品牌标识"],
            "forbid_shift": ["入耳式耳机", "非白色主机身", "其他品牌外观"],
        },
        # Optional public image candidates for prefetch; if blocked, parsing still succeeds.
        "image_urls": [
            "https://m.media-amazon.com/images/I/61Q4f4fWmPL._AC_SL1500_.jpg",
            "https://m.media-amazon.com/images/I/71Y5x3H6WfL._AC_SL1500_.jpg",
        ],
    }
}

_PRESET_IMAGE_CACHE_DIR = Path(__file__).resolve().parents[1] / "cache" / "preset_product_images"


def _extract_amazon_asin(url: str) -> str:
    txt = str(url or "").strip()
    if not txt:
        return ""
    m = re.search(r"/dp/([A-Z0-9]{10})(?:[/?]|$)", txt, re.IGNORECASE)
    if not m:
        m = re.search(r"/gp/product/([A-Z0-9]{10})(?:[/?]|$)", txt, re.IGNORECASE)
    if not m:
        # 部分分享链接仅带 query ?asin= 或移动端路径差异
        m = re.search(r"(?:[?&])asin=([A-Z0-9]{10})\b", txt, re.IGNORECASE)
    if not m:
        m = re.search(r"/gp/aw/d/([A-Z0-9]{10})(?:[/?]|$)", txt, re.IGNORECASE)
    if m:
        return m.group(1).upper()
    return ""


def _load_preset_image_cache(asin: str) -> list:
    if not asin:
        return []
    path = _PRESET_IMAGE_CACHE_DIR / f"{asin}.json"
    if not path.exists():
        return []
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return []
    items = []
    for x in (data if isinstance(data, list) else []):
        b64 = str((x or {}).get("base64") or "").strip()
        mime = str((x or {}).get("mime_type") or "image/jpeg").strip()
        url = str((x or {}).get("url") or "").strip()
        if not b64 or mime not in {"image/png", "image/jpeg"}:
            continue
        items.append({"base64": b64, "mime_type": mime, "url": url})
    return items[:4]


def _save_preset_image_cache(asin: str, items: list) -> None:
    if not asin or not items:
        return
    try:
        _PRESET_IMAGE_CACHE_DIR.mkdir(parents=True, exist_ok=True)
        path = _PRESET_IMAGE_CACHE_DIR / f"{asin}.json"
        path.write_text(json.dumps(items, ensure_ascii=False), encoding="utf-8")
    except Exception:
        # Best-effort cache only; never block request on cache failure.
        return


def _fetch_image_with_headers_as_base64(image_url: str, proxy: str, build_proxies: Callable) -> Tuple[str, str]:
    headers_variants = [
        {
            "User-Agent": (
                "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
                "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
            ),
            "Accept": "image/avif,image/webp,image/apng,image/*,*/*;q=0.8",
            "Referer": "https://www.amazon.com/",
        },
        {
            "User-Agent": "Mozilla/5.0",
            "Accept": "image/*,*/*;q=0.8",
        },
    ]
    last_err = None
    for headers in headers_variants:
        try:
            resp = requests.get(
                image_url,
                timeout=20,
                headers=headers,
                proxies=build_proxies(proxy),
            )
            resp.raise_for_status()
            content_type = resp.headers.get("content-type", "image/jpeg").split(";")[0].strip().lower()
            if content_type not in {"image/png", "image/jpeg"}:
                content_type = "image/jpeg"
            b64 = base64.b64encode(resp.content).decode("utf-8")
            return b64, content_type
        except Exception as e:
            last_err = e
            continue
    raise RuntimeError(str(last_err or "image fetch failed"))


def _execute_agent_tool(tool_name: str, arguments: dict, timeout_seconds: float = 30.0,
                        host_url: str = "", trace_id: str = ""):
    """Execute a registered tool by name via Flask test_request_context.

    Returns (ok: bool, result: dict).
    host_url: if provided, passed as SERVER_NAME so inner views return correct absolute URLs.
    Importable at module level for testing.
    """
    import concurrent.futures as _cf  # noqa: F401 — kept for TimeoutError / cancel usage below
    if tool_name not in _TOOL_ENDPOINT_MAP:
        return False, {"error": f"Unknown tool: {tool_name}", "error_code": "UNKNOWN_TOOL"}
    view_name, path = _TOOL_ENDPOINT_MAP[tool_name]

    def _run():
        from shoplive.backend.web_app import app as _app
        # Pass base_url so request.host_url inside the view returns the real server address.
        # Werkzeug EnvironBuilder respects base_url for SERVER_NAME / HTTP_HOST computation.
        _ctx_kwargs = {}
        if host_url:
            _ctx_kwargs["base_url"] = host_url.rstrip("/") + "/"
        with _app.test_request_context(path, method="POST", json=arguments, **_ctx_kwargs):
            if trace_id:
                from shoplive.backend.audit import start_trace
                start_trace(trace_id)
            view_func = _app.view_functions.get(view_name)
            if not view_func:
                return False, {"error": f"View not registered: {view_name}", "error_code": "VIEW_NOT_FOUND"}
            resp = view_func()
            if isinstance(resp, tuple):
                resp_obj, status = resp[0], int(resp[1])
            else:
                resp_obj, status = resp, 200
            result = resp_obj.get_json(silent=True) if hasattr(resp_obj, "get_json") else {}
            if result is None:
                result = {"error": "Tool returned non-JSON response", "error_code": "INVALID_RESPONSE"}
                return False, result
            # Distinguish validation errors (4xx) from server errors (5xx)
            if 400 <= status < 500:
                result.setdefault("error_code", "TOOL_VALIDATION_ERROR")
            elif status >= 500:
                result.setdefault("error_code", "TOOL_SERVER_ERROR")
            return status < 400, result

    future = get_executor().submit(_run)
    try:
        return future.result(timeout=timeout_seconds)
    except _cf.TimeoutError:
        future.cancel()
        return False, {"error": f"Tool '{tool_name}' timed out after {timeout_seconds}s", "error_code": "TOOL_TIMEOUT"}
    except Exception as exc:
        return False, {"error": str(exc), "error_code": "TOOL_EXCEPTION"}


def _build_agent_system_prompt(enabled_tools: list, context: dict) -> str:
    """Build a concise system prompt for the agentic loop."""
    tool_names_str = ", ".join(enabled_tools) or "none"
    lines = [
        "You are a video production assistant with direct access to tools.",
        f"Available tools: {tool_names_str}",
        "",
        "Guidelines:",
        "- Call tools proactively when the user asks for an action.",
        "- ALWAYS pass the complete edit parameters in the FIRST tool call — never make an empty/exploratory call first.",
        "- Use EXACT field names from the tool schema — do not invent field names like 'text_overlay'; the correct field is 'maskText'.",
        "- After each tool call, summarize the result briefly.",
        "- For video edits, always include the resulting video_url in your reply.",
        "- If a tool returns an error, explain it to the user and suggest a fix.",
        "- Respond in the same language as the user.",
    ]
    if context:
        lines.append("")
        lines.append("Session context:")
        for k, v in context.items():
            # Escape newlines to prevent prompt injection via context values
            safe_v = str(v).replace("\n", "\\n").replace("\r", "\\r")
            lines.append(f"  {k}: {safe_v}")
    return "\n".join(lines)


from shoplive.backend.scraper.adapters import (
    assess_parse_quality,
    get_platform_parser,
    guess_platform as guess_platform_by_url,
    parse_generic_page,
)
from shoplive.backend.scraper.fetchers import (
    fetch_html_with_playwright,
    fetch_html_with_requests,
    is_weak_amazon_html,
)
from shoplive.backend.scraper.models import ParseResult


def register_agent_routes(
    app,
    *,
    json_error: Callable[[str, int], Tuple],
    parse_common_payload: Callable[[Dict], Tuple[str, str, str, str]],
    get_access_token: Callable[[str, str], str],
    build_proxies: Callable[[str], Dict[str, str]],
    normalize_reference_images_base64: Callable[[object], list],
    normalize_reference_urls: Callable[[object], list],
    fetch_image_as_base64: Callable[[str, str], Tuple[str, str]],
    extract_vertex_text: Callable[[Dict], str],
    try_parse_json_object: Callable[[str], Dict],
    call_litellm_chat: Callable[..., Tuple[int, Dict]],
    call_litellm_chat_stream: Callable[..., object],
    extract_chat_content: Callable[[Dict], str],
):
    def _pick_first_non_empty(candidates):
        for item in candidates:
            text = str(item or "").strip()
            if text:
                return text
        return ""

    def _extract_product_jsonld(html_text: str):
        scripts = re.findall(
            r'<script[^>]+type=["\']application/ld\+json["\'][^>]*>([\s\S]*?)</script>',
            html_text or "",
            flags=re.IGNORECASE,
        )
        for raw in scripts:
            raw = raw.strip()
            if not raw:
                continue
            try:
                data = json.loads(raw)
            except Exception:
                continue
            items = data if isinstance(data, list) else [data]
            for obj in items:
                if not isinstance(obj, dict):
                    continue
                t = str(obj.get("@type") or "").lower()
                if t == "product" or ("product" in t):
                    return obj
        return {}

    def _extract_meta(html_text: str, key: str):
        m = re.search(
            rf'<meta[^>]+(?:property|name)=["\']{re.escape(key)}["\'][^>]+content=["\']([^"\']+)["\']',
            html_text or "",
            flags=re.IGNORECASE,
        )
        return html.unescape(m.group(1)).strip() if m else ""

    def _clean_text(raw: str):
        text = re.sub(r"<script[\s\S]*?</script>", " ", raw or "", flags=re.IGNORECASE)
        text = re.sub(r"<style[\s\S]*?</style>", " ", text, flags=re.IGNORECASE)
        text = re.sub(r"<[^>]+>", " ", text)
        text = html.unescape(text)
        text = re.sub(r"\s+", " ", text).strip()
        return text

    def _extract_review_lines(text: str):
        chunks = re.split(r"[。！？\n\r.!?]", text or "")
        out = []
        for c in chunks:
            s = re.sub(r"\s+", " ", c).strip()
            if len(s) < 8 or len(s) > 140:
                continue
            low = s.lower()
            if any(k in low for k in ["review", "rating", "star", "comment"]) or any(
                k in s for k in ["评论", "评价", "买家", "好评", "差评", "星"]
            ):
                out.append(s)
            if len(out) >= 8:
                break
        dedup = []
        seen = set()
        for x in out:
            key = x.lower()
            if key in seen:
                continue
            seen.add(key)
            dedup.append(x)
        return dedup[:6]

    def _guess_platform(product_url: str):
        host = (urlparse(product_url).netloc or "").lower()
        if "shoplazza" in host:
            return "shoplazza"
        if "myshopify.com" in host or "shopify" in host:
            return "shopify"
        if "amazon." in host:
            return "amazon"
        if "aliexpress." in host:
            return "aliexpress"
        if "ebay." in host:
            return "ebay"
        if "temu." in host:
            return "temu"
        if "tiktok." in host:
            return "tiktok-shop"
        if "walmart." in host:
            return "walmart"
        if "etsy." in host:
            return "etsy"
        return "generic"

    def _normalize_url(raw: str, base_url: str):
        u = str(raw or "").strip()
        if not u:
            return ""
        if u.startswith("//"):
            return "https:" + u
        if u.startswith("http://") or u.startswith("https://"):
            return u
        if u.startswith("/"):
            return urljoin(base_url, u)
        return ""

    def _iter_dict_values(obj):
        if isinstance(obj, dict):
            for v in obj.values():
                yield v
                for vv in _iter_dict_values(v):
                    yield vv
        elif isinstance(obj, list):
            for i in obj:
                yield i
                for vv in _iter_dict_values(i):
                    yield vv

    def _extract_product_like_from_inline_json(html_text: str):
        out = []
        script_blocks = re.findall(r"<script[^>]*>([\s\S]*?)</script>", html_text or "", flags=re.IGNORECASE)
        for raw in script_blocks:
            text = (raw or "").strip()
            if not text:
                continue
            candidates = []
            if text.startswith("{") or text.startswith("["):
                candidates.append(text)
            m_next = re.search(r"__NEXT_DATA__\s*=\s*(\{[\s\S]*\})\s*;?\s*$", text)
            if m_next:
                candidates.append(m_next.group(1))
            m_state = re.search(r"__INITIAL_STATE__\s*=\s*(\{[\s\S]*\})\s*;?\s*$", text)
            if m_state:
                candidates.append(m_state.group(1))
            m_product_json = re.search(r"\bProductJson[-\w]*\s*=\s*(\{[\s\S]*\})\s*;?\s*$", text)
            if m_product_json:
                candidates.append(m_product_json.group(1))
            for candidate in candidates:
                try:
                    data = json.loads(candidate)
                except Exception:
                    continue
                nodes = [data] + list(_iter_dict_values(data))
                for node in nodes:
                    if not isinstance(node, dict):
                        continue
                    name = str(node.get("name") or node.get("title") or "").strip()
                    images = node.get("images") or node.get("image") or node.get("featured_image")
                    if name and images:
                        out.append(node)
                        break
        return out

    def _extract_image_urls_from_html(html_text: str, base_url: str):
        urls = []
        for attr in ["og:image", "twitter:image"]:
            u = _extract_meta(html_text, attr)
            uu = _normalize_url(u, base_url)
            if uu:
                urls.append(uu)
        for m in re.findall(r'<img[^>]+(?:src|data-src|data-original)=["\']([^"\']+)["\']', html_text or "", flags=re.IGNORECASE):
            uu = _normalize_url(m, base_url)
            if uu:
                urls.append(uu)
        return list(dict.fromkeys(urls))

    def _extract_amazon_hires_images(html_text: str, base_url: str):
        urls = []
        for m in re.findall(r'data-old-hires=["\']([^"\']+)["\']', html_text or "", flags=re.IGNORECASE):
            uu = _normalize_url(m, base_url)
            if uu:
                urls.append(uu)
        for m in re.findall(r'"hiRes"\s*:\s*"([^"]+)"', html_text or "", flags=re.IGNORECASE):
            uu = _normalize_url(m.replace("\\/", "/"), base_url)
            if uu:
                urls.append(uu)
        for m in re.findall(r'"large"\s*:\s*"([^"]+)"', html_text or "", flags=re.IGNORECASE):
            uu = _normalize_url(m.replace("\\/", "/"), base_url)
            if uu:
                urls.append(uu)
        return list(dict.fromkeys(urls))

    def _score_image_url(url: str, *, source: str, product_name: str, platform: str):
        low = (url or "").lower()
        score = 0
        source_weight = {
            "jsonld": 90,
            "inline": 80,
            "amazon_hires": 95,
            "meta": 40,
            "html_img": 10,
        }
        score += source_weight.get(source, 0)
        if re.search(r"\.(jpg|jpeg|png|webp)(\?|$)", low):
            score += 8
        if any(k in low for k in ["logo", "sprite", "icon", "favicon", "avatar", "banner", "header", "footer", "prime", "badge", "flag", "nav", "menu"]):
            score -= 120
        if any(k in low for k in ["product", "main", "gallery", "large", "original", "zoom", "detail", "hero", "pdp", "sl1500", "sl1200", "ac_sl"]):
            score += 20
        if platform == "amazon":
            if "images-na.ssl-images-amazon.com/images/i/" in low or "/images/i/" in low:
                score += 55
            else:
                score -= 40
            if "_sx" in low or "_sy" in low or "ac_sl" in low:
                score += 16
            if any(k in low for k in ["fls-na.amazon", "amazon-adsystem", "pixel", "/fls/"]):
                score -= 140
            if "prime" in low or "nav" in low:
                score -= 80
        words = [w for w in re.split(r"[\s\-_,/]+", (product_name or "").lower()) if len(w) >= 3][:8]
        if words and any(w in low for w in words):
            score += 10
        if len(low) > 260:
            score += 4
        return score

    def _rank_and_filter_images(candidates, *, product_name: str, platform: str, limit: int = 10):
        scored = []
        seen = set()
        for item in candidates:
            url = str(item.get("url") or "").strip()
            src = str(item.get("source") or "unknown")
            if not url:
                continue
            if url in seen:
                continue
            seen.add(url)
            score = _score_image_url(url, source=src, product_name=product_name, platform=platform)
            if score < 0:
                continue
            scored.append((score, url))
        scored.sort(key=lambda x: x[0], reverse=True)
        return [u for _, u in scored[:limit]]

    def _extract_review_signals(text: str):
        chunks = re.split(r"[。！？\n\r.!?]", text or "")
        pos_kw = [
            "好评",
            "推荐",
            "满意",
            "喜欢",
            "舒适",
            "柔软",
            "质感",
            "值",
            "耐用",
            "great",
            "love",
            "excellent",
            "comfortable",
            "soft",
            "quality",
            "recommend",
            "durable",
        ]
        neg_kw = [
            "差评",
            "退货",
            "掉色",
            "起球",
            "偏小",
            "偏大",
            "慢",
            "问题",
            "不",
            "bad",
            "poor",
            "return",
            "small",
            "large",
            "slow",
            "issue",
            "problem",
            "disappoint",
        ]
        pos = []
        neg = []
        for c in chunks:
            s = re.sub(r"\s+", " ", c).strip()
            if len(s) < 6 or len(s) > 120:
                continue
            low = s.lower()
            if any(k in low for k in [x.lower() for x in pos_kw]):
                pos.append(s)
            if any(k in low for k in [x.lower() for x in neg_kw]):
                neg.append(s)
        def _dedup(lines):
            seen = set()
            out = []
            for x in lines:
                key = x.lower()
                if key in seen:
                    continue
                seen.add(key)
                out.append(x)
                if len(out) >= 5:
                    break
            return out
        return _dedup(pos), _dedup(neg)

    @app.post("/api/agent/shop-product-insight")
    @validate_request(ProductInsightRequest)
    def api_agent_shop_product_insight():
        """Parse a product URL from an e-commerce platform.

        Extracts product name, images, selling points, reviews, and price.
        Supports: Amazon, Shein, Taobao, JD, Temu, Aliexpress, TikTok Shop,
        Etsy, Ebay, Walmart, Shopify, Shoplazza.

        Common follow-up actions:
        - Use extracted data → /api/shoplive/video/workflow to generate video script
        - Use extracted images → /api/agent/image-insight for deeper visual analysis
        """
        _t0 = time.monotonic()
        req = g.req
        try:
            product_url = req.product_url
            proxy = req.proxy
            language = req.language

            asin = _extract_amazon_asin(product_url)
            canonical_url = (
                _AMAZON_STRONG_MATCH_PRESETS.get(asin, {}).get("canonical_url")
                if asin else ""
            ) or product_url

            _cache_key = make_cache_key(canonical_url)

            # Strong-match preset MUST run before generic cache. Otherwise a prior scrape may have
            # cached a weak/empty insight under the same canonical key and the preset path would
            # never run (user sees "parse failed" forever for that ASIN).
            preset = _AMAZON_STRONG_MATCH_PRESETS.get(asin)
            if preset:
                try:
                    _cached_preset = product_insight_cache.get(_cache_key)
                    if _cached_preset is not None and str(_cached_preset.get("source") or "") == "preset_strong_match":
                        audit_log.record(
                            tool="parse_product_url",
                            action="cache_hit",
                            input_summary={"url_domain": urlparse(product_url).netloc, "language": language},
                            output_summary={"cached": True, "preset": True},
                            status="success",
                            duration_ms=int((time.monotonic() - _t0) * 1000),
                        )
                        return jsonify({**_cached_preset, "cache_hit": True})
                    image_items = _load_preset_image_cache(asin)
                    if not image_items:
                        try:
                            from shoplive.backend.async_executor import parallel_fetch_images
                            parallel_results = parallel_fetch_images(
                                preset.get("image_urls", [])[:4],
                                proxy,
                                fetch_fn=fetch_image_as_base64,
                                max_images=4,
                                timeout_seconds=45,
                            )
                            image_items = [
                                {"base64": r["base64"], "mime_type": r["mime_type"], "url": r["url"]}
                                for r in parallel_results if r["ok"]
                            ]
                        except Exception:
                            image_items = []
                    if not image_items:
                        for _u in preset.get("image_urls", [])[:4]:
                            try:
                                _b64, _mime = _fetch_image_with_headers_as_base64(_u, proxy, build_proxies)
                                image_items.append({"base64": _b64, "mime_type": _mime, "url": _u})
                            except Exception:
                                continue
                    if image_items:
                        _save_preset_image_cache(asin, image_items[:4])

                    insight = {
                        "product_name": preset.get("product_name", ""),
                        "main_business": preset.get("main_business", "消费电子"),
                        "style_template": preset.get("style_template", "clean"),
                        "selling_points": preset.get("selling_points", [])[:6],
                        "target_user": preset.get("target_user", ""),
                        "sales_region": preset.get("sales_region", ""),
                        "brand_direction": preset.get("brand_direction", ""),
                        "product_anchors": preset.get("product_anchors", {}),
                        "review_highlights": [],
                        "review_positive_points": [],
                        "review_negative_points": [],
                        "review_summary": "",
                        "image_urls": preset.get("image_urls", [])[:10],
                        "image_items": image_items,
                        "platform": "amazon",
                        "price": "",
                        "currency": "",
                        "fetch_source": "preset_strong_match",
                        "fetch_confidence": "high",
                        "main_image_confidence": "high" if image_items else "medium",
                        "review_extraction_method": "preset",
                    }
                    _result = {
                        "ok": True,
                        "status_code": 200,
                        "url": canonical_url,
                        "insight": insight,
                        "source": "preset_strong_match",
                        "confidence": "high",
                        "fallback_reason": "",
                        "cache_hit": False,
                    }
                    product_insight_cache.set(_cache_key, _result)
                    _cleanup_inflight_key(_cache_key)
                    audit_log.record(
                        tool="parse_product_url",
                        action="strong_match_preset",
                        input_summary={"asin": asin, "url_domain": urlparse(product_url).netloc},
                        output_summary={"image_count": len(image_items), "product_name": insight["product_name"][:80]},
                        status="success",
                        duration_ms=int((time.monotonic() - _t0) * 1000),
                    )
                    return jsonify(_result)
                except Exception as _preset_exc:
                    audit_log.record(
                        tool="parse_product_url",
                        action="strong_match_preset_failed",
                        input_summary={"asin": asin, "url_domain": urlparse(product_url).netloc},
                        output_summary={},
                        status="error",
                        error_code="PRESET_FAILED",
                        error_message=str(_preset_exc)[:300],
                        duration_ms=int((time.monotonic() - _t0) * 1000),
                    )
                    # Fall through to generic cache + scrape instead of returning HTTP 500

            # Cache hit: skip scraping + image fetching entirely
            _cached = product_insight_cache.get(_cache_key)
            if _cached is not None:
                audit_log.record(
                    tool="parse_product_url",
                    action="cache_hit",
                    input_summary={"url_domain": urlparse(product_url).netloc, "language": language},
                    output_summary={"cached": True},
                    status="success",
                    duration_ms=int((time.monotonic() - _t0) * 1000),
                )
                return jsonify({**_cached, "cache_hit": True})

            # Concurrent-request deduplication: if another thread is already scraping
            # this URL, wait for it to finish and return the cached result instead of
            # launching a second parallel scrape (saves scraper quota + LLM cost).
            _inflight_ev = None
            with _insight_inflight_lock:
                if _cache_key in _insight_inflight:
                    _inflight_ev = _insight_inflight[_cache_key]
                else:
                    _insight_inflight[_cache_key] = threading.Event()

            if _inflight_ev is not None:
                _inflight_ev.wait(timeout=120)
                _cached = product_insight_cache.get(_cache_key)
                if _cached is not None:
                    return jsonify({**_cached, "cache_hit": True, "deduped": True})
                # Other thread failed — fall through to our own attempt

            platform = guess_platform_by_url(canonical_url)
            parser = get_platform_parser(platform)
            js_first_platforms = {"amazon", "tiktok-shop", "temu"}
            wait_ms_by_platform = {"amazon": 3800, "tiktok-shop": 4200, "temu": 3600}

            def parse_with_artifact(fetch_artifact):
                if fetch_artifact.status_code >= 400 or not fetch_artifact.html:
                    return ParseResult(platform=platform, source=fetch_artifact.engine, confidence="low")
                if parser is parse_generic_page:
                    result = parser(fetch_artifact.url or canonical_url, fetch_artifact.html, platform)
                else:
                    result = parser(fetch_artifact.url or canonical_url, fetch_artifact.html)
                result.source = fetch_artifact.engine
                return result

            def _artifact_quality(fetch_artifact, parsed_result):
                score = assess_parse_quality(parsed_result)
                html_text = (fetch_artifact.html or "").lower()
                if fetch_artifact.status_code >= 400 or not html_text:
                    return -1
                if platform == "amazon" and is_weak_amazon_html(html_text):
                    score -= 6
                if fetch_artifact.failure_tag in {"anti_bot", "js_challenge", "weak_html", "render_failed"}:
                    score -= 2
                return score

            fallback_reason = ""
            parsed = ParseResult(platform=platform, confidence="low")

            fetch_req = None
            fetch_pw = None

            def _merge_results(primary: ParseResult, secondary: ParseResult) -> ParseResult:
                """Merge two ParseResults: take the best field from each source."""
                # Product name: prefer the longer, more descriptive one
                if not primary.product_name and secondary.product_name:
                    primary.product_name = secondary.product_name
                elif secondary.product_name and len(secondary.product_name) > len(primary.product_name or ""):
                    primary.product_name = secondary.product_name

                # Images: merge unique URLs, keeping order (primary first)
                if secondary.image_urls:
                    seen = set(primary.image_urls)
                    for u in secondary.image_urls:
                        if u not in seen:
                            primary.image_urls.append(u)
                            seen.add(u)

                # Selling points: merge unique points
                if secondary.selling_points:
                    seen_sp = {s.lower() for s in primary.selling_points}
                    for sp in secondary.selling_points:
                        if sp.lower() not in seen_sp:
                            primary.selling_points.append(sp)
                            seen_sp.add(sp.lower())

                # Reviews: merge unique lines
                for attr in ("review_highlights", "review_positive_points", "review_negative_points"):
                    pri_list = getattr(primary, attr, []) or []
                    sec_list = getattr(secondary, attr, []) or []
                    if sec_list:
                        seen_r = {x.lower() for x in pri_list}
                        for r in sec_list:
                            if r.lower() not in seen_r:
                                pri_list.append(r)
                                seen_r.add(r.lower())
                        setattr(primary, attr, pri_list[:8])

                if not primary.review_summary and secondary.review_summary:
                    primary.review_summary = secondary.review_summary
                if not primary.price and secondary.price:
                    primary.price = secondary.price
                    primary.currency = secondary.currency

                # Recalculate confidence after merge
                from shoplive.backend.scraper.adapters.generic_adapter import _build_confidence
                primary.confidence = _build_confidence(primary)
                return primary

            if platform in js_first_platforms:
                fetch_pw = fetch_html_with_playwright(
                    canonical_url,
                    proxy,
                    platform=platform,
                    wait_ms=wait_ms_by_platform.get(platform, 3200),
                )
                parsed = parse_with_artifact(fetch_pw)
                fallback_reason = fetch_pw.failure_tag or fetch_pw.error or ""
                needs_requests = (not fetch_pw.html) or fetch_pw.status_code >= 400 or parsed.confidence == "low"
                if not parsed.product_name or not parsed.image_urls:
                    needs_requests = True
                if platform == "amazon" and fetch_pw.failure_tag in {"weak_html", "anti_bot"}:
                    needs_requests = True
                if needs_requests:
                    fetch_req = fetch_html_with_requests(canonical_url, proxy, build_proxies)
                    parsed_req = parse_with_artifact(fetch_req)
                    if _artifact_quality(fetch_req, parsed_req) >= _artifact_quality(fetch_pw, parsed):
                        # requests result is better: use as primary, merge playwright into it
                        parsed = _merge_results(parsed_req, parsed)
                    else:
                        # playwright result is better: merge requests fields into it
                        parsed = _merge_results(parsed, parsed_req)
                    fallback_reason = fetch_req.failure_tag or fetch_req.error or fallback_reason
            else:
                fetch_req = fetch_html_with_requests(canonical_url, proxy, build_proxies)
                parsed = parse_with_artifact(fetch_req)
                fallback_reason = fetch_req.failure_tag or fetch_req.error or ""
                needs_playwright = bool(fetch_req.anti_bot) or parsed.confidence == "low"
                if not parsed.product_name or not parsed.image_urls:
                    needs_playwright = True
                if needs_playwright:
                    fetch_pw = fetch_html_with_playwright(
                        canonical_url,
                        proxy,
                        platform=platform,
                        wait_ms=wait_ms_by_platform.get(platform, 2200),
                    )
                    parsed_pw = parse_with_artifact(fetch_pw)
                    if _artifact_quality(fetch_pw, parsed_pw) >= _artifact_quality(fetch_req, parsed):
                        parsed = _merge_results(parsed_pw, parsed)
                    else:
                        parsed = _merge_results(parsed, parsed_pw)
                    fallback_reason = fetch_pw.failure_tag or fetch_pw.error or fallback_reason

            if parsed.confidence == "low" and not fallback_reason:
                if fetch_pw and (fetch_pw.failure_tag or fetch_pw.error):
                    fallback_reason = fetch_pw.failure_tag or fetch_pw.error
                elif fetch_req and (fetch_req.failure_tag or fetch_req.error):
                    fallback_reason = fetch_req.failure_tag or fetch_req.error
            if fallback_reason == "weak_html":
                fallback_reason = "weak_html_amazon"

            if not parsed.product_name:
                try:
                    path = urlparse(canonical_url).path or ""
                    slug = path.strip("/").split("/")[-1]
                    if not slug or slug.lower() in {"item.htm", "item.html", "goods.html"}:
                        qid = re.search(r"[?&](?:id|goods_id)=([0-9a-zA-Z_-]+)", canonical_url)
                        if qid:
                            slug = f"{platform} {qid.group(1)}"
                    slug = re.sub(r"\.(html|htm)$", "", slug, flags=re.IGNORECASE)
                    slug = re.sub(r"[-_]+", " ", slug).strip()
                    if slug:
                        parsed.product_name = slug[:80]
                        if not parsed.selling_points:
                            parsed.selling_points = [f"{parsed.product_name[:28]} 核心卖点突出"]
                        if parsed.confidence == "low":
                            parsed.confidence = "medium"
                except Exception:
                    pass

            # Parallel image fetching (Article: "将串行调用转为并行以加速执行")
            from shoplive.backend.async_executor import parallel_fetch_images
            parallel_results = parallel_fetch_images(
                parsed.image_urls[:4],
                proxy,
                fetch_fn=fetch_image_as_base64,
                max_images=4,
                timeout_seconds=60,
            )
            image_items = [
                {"base64": r["base64"], "mime_type": r["mime_type"], "url": r["url"]}
                for r in parallel_results if r["ok"]
            ]

            insight = parsed.to_insight(language)
            insight["image_items"] = image_items
            _dur_ms = int((time.monotonic() - _t0) * 1000)
            audit_log.record(
                tool="parse_product_url",
                action="scrape",
                input_summary={
                    "url_domain": urlparse(product_url).netloc,
                    "language": language,
                    "has_proxy": bool(proxy),
                },
                output_summary={
                    "confidence": parsed.confidence,
                    "image_count": len(image_items),
                    "source": parsed.source,
                    "has_product_name": bool(parsed.product_name),
                },
                status="success",
                duration_ms=_dur_ms,
            )
            _result = {
                "ok": True,
                "status_code": 200,
                "url": canonical_url,
                "insight": insight,
                "source": parsed.source,
                "confidence": parsed.confidence,
                "fallback_reason": fallback_reason,
                "cache_hit": False,
            }
            product_insight_cache.set(_cache_key, _result)
            with _insight_inflight_lock:
                _ev = _insight_inflight.pop(_cache_key, None)
            if _ev: _ev.set()
            return jsonify(_result)
        except Exception as e:
            # Always signal waiting threads on error so they don't block indefinitely
            with _insight_inflight_lock:
                _ev = _insight_inflight.pop(_cache_key, None)
            if _ev: _ev.set()
            audit_log.record(
                tool="parse_product_url",
                action="scrape",
                input_summary={"product_url": req.product_url[:120]},
                output_summary={},
                status="error",
                error_code="SCRAPE_FAILED",
                error_message=str(e)[:200],
                duration_ms=int((time.monotonic() - _t0) * 1000),
            )
            return json_error(
                f"商品链接解析失败: {e}",
                500,
                recovery_suggestion="Check the product URL is valid and accessible. "
                                    "If the page has anti-bot protection, try with a proxy parameter. "
                                    "Alternatively, use /api/agent/image-insight to analyze product images directly.",
                error_code="SCRAPE_FAILED",
            )

    @app.post("/api/agent/image-insight")
    @validate_request(ImageInsightRequest)
    def api_agent_image_insight():
        """Analyze product images using Gemini to extract structured metadata.

        Returns: product_name, main_business, style_template, selling_points,
        target_user, sales_region, brand_direction.

        Common follow-up actions:
        - Use insights → /api/shoplive/video/workflow to generate video script
        - Use insights → /api/shoplive/image/generate to create product images
        """
        _t0 = time.monotonic()
        payload = g.req.model_dump()
        try:
            project_id, key_file, proxy, _ = parse_common_payload(payload)
            model = (payload.get("model") or "gemini-2.5-flash").strip()
            location = (payload.get("location") or "global").strip()
            language = str(payload.get("language") or "zh").strip().lower()
            if language not in {"zh", "en"}:
                language = "zh"

            image_items = normalize_reference_images_base64(payload.get("image_items"))
            image_base64 = str(payload.get("image_base64") or "").strip()
            image_mime_type = str(payload.get("image_mime_type") or "image/jpeg").strip()
            image_url = str(payload.get("image_url") or "").strip()

            if not image_items and image_base64:
                if image_mime_type not in {"image/png", "image/jpeg"}:
                    image_mime_type = "image/jpeg"
                image_items.append({"base64": image_base64, "mime_type": image_mime_type})

            if not image_items and image_url:
                url_list = normalize_reference_urls(image_url)
                for u in url_list[:6]:
                    try:
                        b64, mime = fetch_image_as_base64(u, proxy)
                        image_items.append({"base64": b64, "mime_type": mime})
                    except Exception:
                        continue

            if not image_items:
                return json_error(
                    "image_items 或 image_base64 或 image_url 至少提供一个",
                    recovery_suggestion="Provide at least one of: "
                                        "image_items (list of {base64, mime_type}), "
                                        "image_base64 (base64 string), or "
                                        "image_url (HTTP URL to the product image).",
                    error_code="MISSING_IMAGE",
                )

            token = get_access_token(key_file, proxy)
            url = (
                "https://aiplatform.googleapis.com/v1/projects/"
                f"{project_id}/locations/{location}/publishers/google/models/{model}:generateContent"
            )
            headers = {
                "Authorization": f"Bearer {token}",
                "Content-Type": "application/json; charset=utf-8",
            }
            prompt = (
                "You are an ecommerce product analyst. "
                f"Given 1-6 product images of the same product (count={len(image_items)}), infer key listing fields for a video-creation form. "
                "Return JSON only, no markdown, no extra text. "
                "Schema:\n"
                "{\n"
                '  "product_name": "short product name",\n'
                '  "main_business": "high-level business/category",\n'
                '  "style_template": "clean|lifestyle|premium|social",\n'
                '  "selling_points": ["point1", "point2"],\n'
                '  "target_user": "optional short suggestion",\n'
                '  "sales_region": "optional short suggestion",\n'
                '  "brand_direction": "optional short suggestion",\n'
                '  "product_anchors": {\n'
                '    "category": "specific product subtype",\n'
                '    "colors": ["main color 1", "main color 2"],\n'
                '    "materials": ["material 1", "material 2"],\n'
                '    "silhouette": "shape / outline / cut",\n'
                '    "key_details": ["detail 1", "detail 2"],\n'
                '    "keep_elements": ["must-keep feature 1", "must-keep feature 2"],\n'
                '    "usage_scenarios": ["scenario 1", "scenario 2"],\n'
                '    "avoid_elements": ["wrong category/material/style to avoid"]\n'
                '  }\n'
                "}\n"
                "Rules: synthesize across all images and prefer consistent attributes; "
                "keep concise; selling_points 1-4 items; "
                "if uncertain use conservative defaults for ecommerce. "
                "product_anchors must focus on preserving product identity for later video generation.\n"
                f"Output language for all human-readable fields: {'Chinese' if language == 'zh' else 'English'}. "
                "Keep style_template strictly in: clean|lifestyle|premium|social."
            )
            parts = [{"text": prompt}]
            for item in image_items[:6]:
                b64 = str(item.get("base64") or "").strip()
                mime = str(item.get("mime_type") or "image/jpeg").strip()
                if not b64:
                    continue
                if mime not in {"image/png", "image/jpeg"}:
                    mime = "image/jpeg"
                parts.append({"inlineData": {"mimeType": mime, "data": b64}})

            body = {
                "contents": [
                    {
                        "role": "user",
                        "parts": parts,
                    }
                ]
            }
            resp = requests.post(
                url,
                headers=headers,
                json=body,
                timeout=90,
                proxies=build_proxies(proxy),
            )
            data = (
                resp.json()
                if resp.headers.get("content-type", "").find("json") >= 0
                else {"raw": resp.text}
            )
            raw_text = extract_vertex_text(data)
            parsed = try_parse_json_object(raw_text)

            selling_points = parsed.get("selling_points", [])
            if isinstance(selling_points, str):
                selling_points = [x.strip() for x in re.split(r"[,\n;；，]", selling_points) if x.strip()]
            if not isinstance(selling_points, list):
                selling_points = []
            selling_points = [str(x).strip() for x in selling_points if str(x).strip()][:6]

            style_template = str(parsed.get("style_template") or "clean").strip().lower()
            if style_template not in {"clean", "lifestyle", "premium", "social"}:
                style_template = "clean"

            product_anchors = parsed.get("product_anchors", {})
            if not isinstance(product_anchors, dict):
                product_anchors = {}
            def _norm_list(value, limit=6):
                if isinstance(value, list):
                    vals = [str(x).strip() for x in value if str(x).strip()]
                else:
                    vals = [x.strip() for x in re.split(r"[,\n;；，、]", str(value or "")) if x.strip()]
                return vals[:limit]
            product_anchors = {
                "category": str(product_anchors.get("category") or "").strip(),
                "colors": _norm_list(product_anchors.get("colors"), 5),
                "materials": _norm_list(product_anchors.get("materials"), 5),
                "silhouette": str(product_anchors.get("silhouette") or "").strip(),
                "key_details": _norm_list(product_anchors.get("key_details"), 6),
                "keep_elements": _norm_list(product_anchors.get("keep_elements"), 6),
                "usage_scenarios": _norm_list(product_anchors.get("usage_scenarios"), 4),
                "avoid_elements": _norm_list(product_anchors.get("avoid_elements"), 4),
            }

            insight = {
                "product_name": str(parsed.get("product_name") or "").strip(),
                "main_business": str(parsed.get("main_business") or "").strip(),
                "style_template": style_template,
                "selling_points": selling_points,
                "target_user": str(parsed.get("target_user") or "").strip(),
                "sales_region": str(parsed.get("sales_region") or "").strip(),
                "brand_direction": str(parsed.get("brand_direction") or "").strip(),
                "product_anchors": product_anchors,
            }

            _dur_ms = int((time.monotonic() - _t0) * 1000)
            audit_log.record(
                tool="analyze_product_image",
                action="gemini_vision",
                input_summary={
                    "image_count": len(image_items[:6]),
                    "model": model,
                    "language": language,
                },
                output_summary={
                    "product_name": insight.get("product_name", "")[:40],
                    "style_template": insight.get("style_template", ""),
                    "selling_points_count": len(insight.get("selling_points", [])),
                    "gemini_status": resp.status_code,
                },
                status="success" if resp.ok else "error",
                duration_ms=_dur_ms,
            )
            return jsonify(
                {
                    "ok": resp.ok,
                    "status_code": resp.status_code,
                    "model": model,
                    "language": language,
                    "image_count": len(image_items[:6]),
                    "insight": insight,
                    "raw_text": raw_text,
                    "response": data,
                }
            ), resp.status_code
        except ValueError as e:
            audit_log.record(
                tool="analyze_product_image",
                action="gemini_vision",
                input_summary={"image_count": len(payload.get("image_items") or [])},
                output_summary={},
                status="validation_error",
                error_message=str(e)[:200],
                duration_ms=int((time.monotonic() - _t0) * 1000),
            )
            return json_error(str(e))
        except Exception as e:
            audit_log.record(
                tool="analyze_product_image",
                action="gemini_vision",
                input_summary={"image_count": len(payload.get("image_items") or [])},
                output_summary={},
                status="error",
                error_code="IMAGE_INSIGHT_FAILED",
                error_message=str(e)[:200],
                duration_ms=int((time.monotonic() - _t0) * 1000),
            )
            return json_error(
                f"Agent 图片解析失败: {e}",
                500,
                recovery_suggestion="Check image format (only PNG/JPEG supported). "
                                    "Ensure image URL is accessible or base64 data is valid. "
                                    "Try with fewer images if timeout occurs.",
                error_code="IMAGE_INSIGHT_FAILED",
            )

    @app.post("/api/agent/chat")
    @validate_request(AgentChatRequest)
    def api_agent_chat():
        """General-purpose LLM chat interface via LiteLLM.

        Provide either 'messages' (full conversation) or 'prompt' (single message).

        Common follow-up actions:
        - For product-related questions → use parse_product_url or analyze_product_image instead
        - For video prompt refinement → use /api/shoplive/video/workflow with action='build_enhance_template'
        """
        _t0 = time.monotonic()
        req = g.req
        try:
            api_base = (
                req.api_base
                or os.getenv("LITELLM_API_BASE")
                or "https://litellm.shoplazza.site"
            ).strip().rstrip("/")
            api_key = (req.api_key or os.getenv("LITELLM_API_KEY") or "").strip()
            model = (req.model or os.getenv("VERTEX_MODEL") or os.getenv("LITELLM_MODEL") or "gemini-2.5-flash").strip()
            proxy = req.proxy
            messages = req.messages
            prompt = req.prompt
            temperature = req.temperature
            max_tokens = req.max_tokens
            top_p = req.top_p
            stream = bool(req.stream)

            if not model:
                return json_error(
                    "agent model 不能为空",
                    recovery_suggestion="Set model in the request payload (e.g., 'gemini-2.5-flash'), "
                                        "or configure the VERTEX_MODEL environment variable.",
                    error_code="MISSING_MODEL",
                )

            if not isinstance(messages, list) or not messages:
                if not prompt:
                    return json_error(
                        "messages 或 prompt 至少提供一个",
                        recovery_suggestion="Provide either 'prompt' (a string) for a single-turn chat, "
                                            "or 'messages' (a list of {role, content} objects) for multi-turn conversation.",
                        error_code="MISSING_INPUT",
                    )
                messages = [{"role": "user", "content": prompt}]

            if stream:
                def _pack_sse(event_name: str, payload: Dict) -> str:
                    return f"event: {event_name}\ndata: {json.dumps(payload, ensure_ascii=False)}\n\n"

                def _event_stream():
                    started = time.monotonic()
                    full_content_parts = []
                    yield _pack_sse(
                        "start",
                        {
                            "ok": True,
                            "model": model,
                            "message_count": len(messages),
                        },
                    )
                    try:
                        for chunk in call_litellm_chat_stream(
                            api_base=api_base,
                            api_key=api_key,
                            model=model,
                            messages=messages,
                            proxy=proxy,
                            temperature=temperature,
                            max_tokens=max_tokens,
                            top_p=top_p,
                        ):
                            chunk_type = str(chunk.get("type") or "").strip().lower()
                            if chunk_type == "delta":
                                delta = str(chunk.get("delta") or "")
                                if delta:
                                    full_content_parts.append(delta)
                                    yield _pack_sse("delta", {"delta": delta})
                                continue
                            if chunk_type == "done":
                                final_content = str(chunk.get("content") or "".join(full_content_parts))
                                status_code = int(chunk.get("status_code") or 200)
                                _dur_ms = int((time.monotonic() - started) * 1000)
                                audit_log.record(
                                    tool="chat_with_llm",
                                    action="litellm_chat_stream",
                                    input_summary={
                                        "model": model,
                                        "message_count": len(messages),
                                        "prompt_length": len(prompt),
                                    },
                                    output_summary={
                                        "status_code": status_code,
                                        "content_length": len(final_content),
                                        "ok": True,
                                    },
                                    status="success",
                                    duration_ms=_dur_ms,
                                )
                                yield _pack_sse(
                                    "done",
                                    {
                                        "ok": True,
                                        "status_code": status_code,
                                        "model": model,
                                        "content": final_content,
                                    },
                                )
                                return
                        final_content = "".join(full_content_parts)
                        _dur_ms = int((time.monotonic() - started) * 1000)
                        audit_log.record(
                            tool="chat_with_llm",
                            action="litellm_chat_stream",
                            input_summary={
                                "model": model,
                                "message_count": len(messages),
                                "prompt_length": len(prompt),
                            },
                            output_summary={
                                "status_code": 200,
                                "content_length": len(final_content),
                                "ok": True,
                            },
                            status="success",
                            duration_ms=_dur_ms,
                        )
                        yield _pack_sse(
                            "done",
                            {"ok": True, "status_code": 200, "model": model, "content": final_content},
                        )
                    except Exception as e:
                        _dur_ms = int((time.monotonic() - started) * 1000)
                        audit_log.record(
                            tool="chat_with_llm",
                            action="litellm_chat_stream",
                            input_summary={
                                "model": model,
                                "message_count": len(messages),
                            },
                            output_summary={},
                            status="error",
                            error_code="CHAT_STREAM_FAILED",
                            error_message=str(e)[:200],
                            duration_ms=_dur_ms,
                        )
                        yield _pack_sse(
                            "error",
                            {
                                "ok": False,
                                "error": str(e),
                                "error_code": "CHAT_STREAM_FAILED",
                            },
                        )

                headers = {
                    "Cache-Control": "no-cache, no-transform",
                    "Connection": "keep-alive",
                    "X-Accel-Buffering": "no",
                }
                return Response(
                    stream_with_context(_event_stream()),
                    headers=headers,
                    mimetype="text/event-stream",
                )

            status_code, data_wrap = call_litellm_chat(
                api_base=api_base,
                api_key=api_key,
                model=model,
                messages=messages,
                proxy=proxy,
                temperature=temperature,
                max_tokens=max_tokens,
                top_p=top_p,
            )
            data = data_wrap.get("response", {})
            content = extract_chat_content(data)
            _dur_ms = int((time.monotonic() - _t0) * 1000)
            audit_log.record(
                tool="chat_with_llm",
                action="litellm_chat",
                input_summary={
                    "model": model,
                    "message_count": len(messages),
                    "prompt_length": len(prompt),
                },
                output_summary={
                    "status_code": status_code,
                    "content_length": len(content),
                    "ok": data_wrap.get("ok", False),
                },
                status="success" if data_wrap.get("ok") else "error",
                duration_ms=_dur_ms,
            )
            return jsonify(
                {
                    "ok": data_wrap.get("ok", False),
                    "status_code": status_code,
                    "model": model,
                    "content": content,
                    "response": data,
                }
            ), status_code
        except Exception as e:
            audit_log.record(
                tool="chat_with_llm",
                action="litellm_chat",
                input_summary={
                    "model": req.model,
                    "message_count": len(req.messages or []),
                },
                output_summary={},
                status="error",
                error_code="CHAT_FAILED",
                error_message=str(e)[:200],
                duration_ms=int((time.monotonic() - _t0) * 1000),
            )
            return json_error(
                f"Agent Chat 调用失败: {e}",
                500,
                recovery_suggestion="Check api_key and model configuration. "
                                    "Verify the LiteLLM API base is reachable. "
                                    "Try with a proxy if behind a firewall.",
                error_code="CHAT_FAILED",
            )

    @app.post("/api/agent/run")
    @validate_request(AgentRunRequest)
    def api_agent_run():
        """Agentic tool-calling loop — always streams SSE events.

        Event types emitted:
          start        {"ok", "model", "tools_enabled", "max_rounds"}
          thinking     {"round", "message"}
          tool_call    {"round", "tool_name", "tool_call_id", "args"}
          tool_result  {"round", "tool_name", "tool_call_id", "ok", "result", "video_url"?}
          delta        {"delta"}   — LLM text chunks for the final reply
          done         {"ok", "content", "rounds_used", "tool_calls_made"}
          error        {"ok", "error", "error_code"}
        """
        import shoplive.backend.common.helpers as _h
        from shoplive.backend.tool_registry import build_openai_tools

        _t0 = time.monotonic()
        req = g.req  # AgentRunRequest

        api_base = (req.api_base or os.getenv("LITELLM_API_BASE") or "https://litellm.shoplazza.site").rstrip("/")
        api_key  = req.api_key or os.getenv("LITELLM_API_KEY") or ""
        model    = (req.model or os.getenv("VERTEX_MODEL") or os.getenv("LITELLM_MODEL") or "gemini-2.5-flash").strip()
        proxy    = req.proxy
        max_rounds = req.max_rounds
        context  = req.context or {}
        # Capture host_url from the real incoming request so inner tool views return correct URLs
        _host_url = request.host_url.rstrip("/")

        # Resolve which tools to enable
        requested = req.tools
        if requested and requested == ["*"]:
            enabled_tool_names = list(_ALL_AGENT_TOOL_NAMES)
        elif requested:
            enabled_tool_names = [t for t in requested if t in _TOOL_ENDPOINT_MAP]
        else:
            enabled_tool_names = list(_DEFAULT_AGENT_TOOLS)

        openai_tools = build_openai_tools(enabled_tool_names)

        # Build initial messages
        messages = list(req.messages or [])
        if not messages:
            if not req.prompt:
                return json_error("messages 或 prompt 至少提供一个", error_code="MISSING_INPUT")
            messages = [{"role": "user", "content": req.prompt}]

        # Inject system prompt (prepend if not already present)
        if not messages or messages[0].get("role") != "system":
            sys_prompt = _build_agent_system_prompt(enabled_tool_names, context)
            messages = [{"role": "system", "content": sys_prompt}] + messages

        def _pack(event: str, payload: dict) -> str:
            return f"event: {event}\ndata: {json.dumps(payload, ensure_ascii=False)}\n\n"

        def _event_stream():
            nonlocal messages
            rounds_used = 0
            tool_calls_made = 0
            final_content = ""

            yield _pack("start", {
                "ok": True,
                "model": model,
                "tools_enabled": enabled_tool_names,
                "max_rounds": max_rounds,
            })

            try:
                for round_num in range(1, max_rounds + 1):
                    rounds_used = round_num
                    # Trim history before each LLM call: keep system prompt + last N-1 msgs
                    if len(messages) > AGENT_MAX_HISTORY:
                        messages = messages[:1] + messages[-(AGENT_MAX_HISTORY - 1):]
                    yield _pack("thinking", {"round": round_num, "message": "calling LLM..."})

                    sc, wrap = _h.call_vertex_chat(
                        api_base=api_base, api_key=api_key, model=model,
                        messages=messages, proxy=proxy,
                        temperature=req.temperature, max_tokens=req.max_tokens,
                        tools=openai_tools if openai_tools else None,
                    )
                    if not wrap.get("ok"):
                        yield _pack("error", {
                            "ok": False,
                            "error": f"LLM call failed: status={sc}",
                            "error_code": "LLM_FAILED",
                        })
                        return

                    raw_resp = wrap.get("response", {})
                    tool_calls = _h.extract_tool_calls(raw_resp)
                    assistant_content = extract_chat_content(raw_resp)

                    # Append assistant message (may have tool_calls)
                    assistant_msg: dict = {"role": "assistant", "content": assistant_content or None}
                    if tool_calls:
                        assistant_msg["tool_calls"] = tool_calls
                    messages.append(assistant_msg)

                    if not tool_calls:
                        # No more tool calls → final reply
                        final_content = assistant_content
                        for ch in (final_content or ""):
                            yield _pack("delta", {"delta": ch})
                        break

                    # Execute each tool call
                    for tc in tool_calls:
                        fn = tc.get("function") or {}
                        tool_name = fn.get("name", "")
                        tool_call_id = tc.get("id", "")
                        raw_args = fn.get("arguments") or "{}"
                        parse_error = None
                        try:
                            args = json.loads(raw_args)
                        except Exception as _je:
                            args = {}
                            parse_error = str(_je)

                        yield _pack("tool_call", {
                            "round": round_num,
                            "tool_name": tool_name,
                            "tool_call_id": tool_call_id,
                            "args": args,
                        })

                        if parse_error:
                            ok = False
                            result = {"error": f"Invalid tool arguments JSON: {parse_error}", "error_code": "ARGS_PARSE_ERROR"}
                        else:
                            _trace_id = getattr(g, "trace_id", "") or ""
                            ok, result = _execute_agent_tool(tool_name, args, host_url=_host_url, trace_id=_trace_id)
                        tool_calls_made += 1

                        # Extract video_url for convenience
                        video_url = result.get("video_url") or result.get("final_signed_video_url") or ""

                        yield _pack("tool_result", {
                            "round": round_num,
                            "tool_name": tool_name,
                            "tool_call_id": tool_call_id,
                            "ok": ok,
                            "result": result,
                            **({"video_url": video_url} if video_url else {}),
                        })

                        # Feed result back as tool message
                        messages.append({
                            "role": "tool",
                            "tool_call_id": tool_call_id,
                            "content": json.dumps(result, ensure_ascii=False),
                        })

                else:
                    # max_rounds exhausted — ask LLM for final summary
                    yield _pack("thinking", {"round": max_rounds + 1, "message": "generating summary..."})
                    sc2, wrap2 = _h.call_vertex_chat(
                        api_base=api_base, api_key=api_key, model=model,
                        messages=messages, proxy=proxy,
                        temperature=req.temperature, max_tokens=req.max_tokens,
                    )
                    final_content = extract_chat_content(wrap2.get("response", {})) if wrap2.get("ok") else ""
                    for ch in (final_content or ""):
                        yield _pack("delta", {"delta": ch})

                _dur_ms = int((time.monotonic() - _t0) * 1000)
                audit_log.record(
                    tool="agent_run", action="agentic_loop",
                    input_summary={"model": model, "tools": enabled_tool_names,
                                   "message_count": len(req.messages or [])},
                    output_summary={"rounds_used": rounds_used, "tool_calls_made": tool_calls_made,
                                    "content_length": len(final_content)},
                    status="success", duration_ms=_dur_ms,
                )
                yield _pack("done", {
                    "ok": True,
                    "content": final_content,
                    "rounds_used": rounds_used,
                    "tool_calls_made": tool_calls_made,
                })

            except Exception as exc:
                _dur_ms = int((time.monotonic() - _t0) * 1000)
                audit_log.record(
                    tool="agent_run", action="agentic_loop",
                    input_summary={"model": model},
                    output_summary={},
                    status="error", error_code="AGENT_RUN_FAILED",
                    error_message=str(exc)[:200], duration_ms=_dur_ms,
                )
                yield _pack("error", {"ok": False, "error": str(exc), "error_code": "AGENT_RUN_FAILED"})

        return Response(
            stream_with_context(_event_stream()),
            mimetype="text/event-stream",
            headers={
                "Cache-Control": "no-cache, no-transform",
                "Connection": "keep-alive",
                "X-Accel-Buffering": "no",
            },
        )

