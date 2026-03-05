import os
import re
import json
import html
import time
from urllib.parse import urljoin, urlparse
from typing import Callable, Dict, Tuple

import requests
from flask import Response, g, jsonify, request, stream_with_context

from shoplive.backend.audit import audit_log
from shoplive.backend.validation import validate_request
from shoplive.backend.schemas import (
    AgentChatRequest,
    ImageInsightRequest,
    ProductInsightRequest,
)

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

    def _is_anti_bot_page(html_text: str):
        text = (html_text or "").lower()
        title = ""
        mt = re.search(r"<title>([\s\S]*?)</title>", html_text or "", flags=re.IGNORECASE)
        if mt:
            title = _clean_text(mt.group(1)).lower()
        strong = [
            "pardon our interruption",
            "robot check",
            "verify you are human",
            "access denied",
            "service unavailable",
        ]
        if any(k in title for k in strong):
            return True
        weak_hits = 0
        weak_flags = [
            "cf-chl",
            "/challenge-platform/",
            "hcaptcha",
            "g-recaptcha",
            "unusual traffic",
            "automated access",
            "bot detection",
        ]
        for k in weak_flags:
            if k in text:
                weak_hits += 1
        return weak_hits >= 2

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
            platform = guess_platform_by_url(product_url)
            parser = get_platform_parser(platform)
            js_first_platforms = {"amazon", "tiktok-shop", "temu"}
            wait_ms_by_platform = {"amazon": 3800, "tiktok-shop": 4200, "temu": 3600}

            def parse_with_artifact(fetch_artifact):
                if fetch_artifact.status_code >= 400 or not fetch_artifact.html:
                    return ParseResult(platform=platform, source=fetch_artifact.engine, confidence="low")
                if parser is parse_generic_page:
                    result = parser(fetch_artifact.url or product_url, fetch_artifact.html, platform)
                else:
                    result = parser(fetch_artifact.url or product_url, fetch_artifact.html)
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

            if platform in js_first_platforms:
                fetch_pw = fetch_html_with_playwright(
                    product_url,
                    proxy,
                    platform=platform,
                    wait_ms=wait_ms_by_platform.get(platform, 3200),
                )
                parsed = parse_with_artifact(fetch_pw)
                fallback_reason = fetch_pw.failure_tag or fetch_pw.error or ""
                needs_requests = (not fetch_pw.html) or fetch_pw.status_code >= 400 or parsed.confidence == "low"
                if not parsed.product_name or not parsed.image_urls:
                    needs_requests = True
                if platform == "amazon" and fetch_pw.failure_tag == "weak_html":
                    needs_requests = True
                if needs_requests:
                    fetch_req = fetch_html_with_requests(product_url, proxy, build_proxies)
                    parsed_req = parse_with_artifact(fetch_req)
                    if _artifact_quality(fetch_req, parsed_req) >= _artifact_quality(fetch_pw, parsed):
                        parsed = parsed_req
                    fallback_reason = fetch_req.failure_tag or fetch_req.error or fallback_reason
            else:
                fetch_req = fetch_html_with_requests(product_url, proxy, build_proxies)
                parsed = parse_with_artifact(fetch_req)
                fallback_reason = fetch_req.failure_tag or fetch_req.error or ""
                needs_playwright = bool(fetch_req.anti_bot) or parsed.confidence == "low"
                if not parsed.product_name or not parsed.image_urls:
                    needs_playwright = True
                if needs_playwright:
                    fetch_pw = fetch_html_with_playwright(
                        product_url,
                        proxy,
                        platform=platform,
                        wait_ms=wait_ms_by_platform.get(platform, 2200),
                    )
                    parsed_pw = parse_with_artifact(fetch_pw)
                    if _artifact_quality(fetch_pw, parsed_pw) >= _artifact_quality(fetch_req, parsed):
                        parsed = parsed_pw
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
                    path = urlparse(product_url).path or ""
                    slug = path.strip("/").split("/")[-1]
                    if not slug or slug.lower() in {"item.htm", "item.html", "goods.html"}:
                        qid = re.search(r"[?&](?:id|goods_id)=([0-9a-zA-Z_-]+)", product_url)
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
            return jsonify(
                {
                    "ok": True,
                    "status_code": 200,
                    "url": product_url,
                    "insight": insight,
                    "source": parsed.source,
                    "confidence": parsed.confidence,
                    "fallback_reason": fallback_reason,
                }
            )
        except Exception as e:
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
                "You are a fashion ecommerce product analyst. "
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
                '  "brand_direction": "optional short suggestion"\n'
                "}\n"
                "Rules: synthesize across all images and prefer consistent attributes; "
                "keep concise; selling_points 1-4 items; "
                "if uncertain use conservative defaults for fashion ecommerce.\n"
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

            insight = {
                "product_name": str(parsed.get("product_name") or "").strip(),
                "main_business": str(parsed.get("main_business") or "").strip(),
                "style_template": style_template,
                "selling_points": selling_points,
                "target_user": str(parsed.get("target_user") or "").strip(),
                "sales_region": str(parsed.get("sales_region") or "").strip(),
                "brand_direction": str(parsed.get("brand_direction") or "").strip(),
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
            model = (req.model or os.getenv("LITELLM_MODEL") or "azure-gpt-5").strip()
            proxy = req.proxy
            messages = req.messages
            prompt = req.prompt
            temperature = req.temperature
            max_tokens = req.max_tokens
            top_p = req.top_p
            stream = bool(req.stream)

            if not api_key:
                return json_error(
                    "agent api_key 不能为空（可通过 payload.api_key 或 LITELLM_API_KEY 提供）",
                    recovery_suggestion="Set api_key in the request payload, or configure the "
                                        "LITELLM_API_KEY environment variable in .env file.",
                    error_code="MISSING_API_KEY",
                )
            if not model:
                return json_error(
                    "agent model 不能为空",
                    recovery_suggestion="Set model in the request payload (e.g., 'azure-gpt-5'), "
                                        "or configure the LITELLM_MODEL environment variable.",
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

