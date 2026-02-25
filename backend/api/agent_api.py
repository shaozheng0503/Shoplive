import os
import re
import json
import html
from urllib.parse import urljoin, urlparse
from typing import Callable, Dict, Tuple

import requests
from flask import jsonify, request


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
    def api_agent_shop_product_insight():
        payload = request.get_json(silent=True) or {}
        try:
            product_url = str(payload.get("product_url") or "").strip()
            proxy = str(payload.get("proxy") or "").strip()
            language = str(payload.get("language") or "zh").strip().lower()
            if language not in {"zh", "en"}:
                language = "zh"
            if not product_url or not re.match(r"^https?://", product_url, flags=re.IGNORECASE):
                return json_error("product_url 不能为空且必须是 http/https 链接")

            req_headers = {
                "User-Agent": (
                    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
                    "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36"
                ),
                "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
                "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
                "Cache-Control": "no-cache",
                "Pragma": "no-cache",
            }
            resp = requests.get(product_url, timeout=45, proxies=build_proxies(proxy), headers=req_headers)
            if resp.status_code >= 400:
                req_headers["User-Agent"] = (
                    "Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) "
                    "AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1"
                )
                resp = requests.get(product_url, timeout=45, proxies=build_proxies(proxy), headers=req_headers)
                if resp.status_code >= 400:
                    return json_error(f"商品链接抓取失败: HTTP {resp.status_code}", 502)
            html_text = resp.text or ""
            if _is_anti_bot_page(html_text):
                return json_error("目标站点启用了反爬拦截（验证码/风控页），当前无法直接抓取详情页", 502)
            platform = _guess_platform(product_url)

            product_ld = _extract_product_jsonld(html_text)
            product_candidates = _extract_product_like_from_inline_json(html_text)
            product_inline = product_candidates[0] if product_candidates else {}
            meta_title = _extract_meta(html_text, "og:title")
            meta_desc = _extract_meta(html_text, "og:description")
            meta_image = _extract_meta(html_text, "og:image")
            title_tag = ""
            title_m = re.search(r"<title>([\s\S]*?)</title>", html_text, flags=re.IGNORECASE)
            if title_m:
                title_tag = _clean_text(title_m.group(1))

            product_name = _pick_first_non_empty(
                [
                    product_ld.get("name", ""),
                    product_inline.get("title", ""),
                    product_inline.get("name", ""),
                    meta_title,
                    title_tag,
                ]
            )
            description = _pick_first_non_empty(
                [
                    product_ld.get("description", ""),
                    product_inline.get("description", ""),
                    product_inline.get("body_html", ""),
                    meta_desc,
                ]
            )
            description_plain = _clean_text(description)

            image_candidates = []
            ld_image = product_ld.get("image")
            if isinstance(ld_image, str) and ld_image.strip():
                image_candidates.append({"url": ld_image.strip(), "source": "jsonld"})
            elif isinstance(ld_image, list):
                for u in ld_image:
                    uu = str(u or "").strip()
                    if uu and uu.startswith("http"):
                        image_candidates.append({"url": uu, "source": "jsonld"})
            inline_images = product_inline.get("images") or product_inline.get("image") or product_inline.get("featured_image")
            if isinstance(inline_images, str):
                uu = _normalize_url(inline_images, product_url)
                if uu:
                    image_candidates.append({"url": uu, "source": "inline"})
            elif isinstance(inline_images, list):
                for u in inline_images:
                    if isinstance(u, dict):
                        u = u.get("src") or u.get("url") or ""
                    uu = _normalize_url(str(u or ""), product_url)
                    if uu:
                        image_candidates.append({"url": uu, "source": "inline"})
            if meta_image and meta_image.startswith("http"):
                image_candidates.append({"url": meta_image, "source": "meta"})
            for u in _extract_image_urls_from_html(html_text, product_url):
                image_candidates.append({"url": u, "source": "html_img"})
            if platform == "amazon":
                for u in _extract_amazon_hires_images(html_text, product_url):
                    image_candidates.append({"url": u, "source": "amazon_hires"})
            if platform == "aliexpress":
                for m in re.findall(r'"imagePathList"\s*:\s*\[([^\]]+)\]', html_text or "", flags=re.IGNORECASE):
                    for u in re.findall(r'"([^"]+)"', m):
                        uu = _normalize_url(u.replace("\\/", "/"), product_url)
                        if uu:
                            image_candidates.append({"url": uu, "source": "inline"})
                if not product_name:
                    m_title = re.search(r'"subject"\s*:\s*"([^"]+)"', html_text or "", flags=re.IGNORECASE)
                    if m_title:
                        product_name = html.unescape(m_title.group(1)).strip()
            images = _rank_and_filter_images(
                image_candidates,
                product_name=product_name,
                platform=platform,
                limit=10,
            )

            selling_points = []
            if description_plain:
                parts = re.split(r"[，,。.;；!！?？\n]", description_plain)
                for p in parts:
                    s = p.strip(" -:：")
                    if len(s) < 5 or len(s) > 42:
                        continue
                    selling_points.append(s)
                    if len(selling_points) >= 4:
                        break

            page_text = _clean_text(html_text)
            review_lines = _extract_review_lines(page_text)
            review_pos, review_neg = _extract_review_signals(page_text)
            review_summary = "；".join((review_pos[:2] + review_neg[:1])) if (review_pos or review_neg) else ("；".join(review_lines[:3]) if review_lines else "")

            image_items = []
            for u in images[:4]:
                try:
                    b64, mime = fetch_image_as_base64(u, proxy)
                    image_items.append({"base64": b64, "mime_type": mime, "url": u})
                except Exception:
                    continue

            offers = product_ld.get("offers") if isinstance(product_ld, dict) else {}
            if isinstance(offers, list):
                offers = offers[0] if offers else {}
            price = ""
            currency = ""
            if isinstance(offers, dict):
                price = str(offers.get("price") or "").strip()
                currency = str(offers.get("priceCurrency") or "").strip()

            insight = {
                "product_name": product_name,
                "main_business": "鞋服配饰" if language == "zh" else "fashion ecommerce",
                "style_template": "clean",
                "selling_points": selling_points,
                "target_user": "",
                "sales_region": "",
                "brand_direction": "",
                "review_highlights": review_lines,
                "review_positive_points": review_pos,
                "review_negative_points": review_neg,
                "review_summary": review_summary,
                "image_urls": images,
                "image_items": image_items,
                "platform": platform,
                "price": price,
                "currency": currency,
            }
            return jsonify(
                {
                    "ok": True,
                    "status_code": 200,
                    "url": product_url,
                    "insight": insight,
                }
            )
        except Exception as e:
            return json_error(f"商品链接解析失败: {e}", 500)

    @app.post("/api/agent/image-insight")
    def api_agent_image_insight():
        payload = request.get_json(silent=True) or {}
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
                return json_error("image_items 或 image_base64 或 image_url 至少提供一个")

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
            return json_error(str(e))
        except Exception as e:
            return json_error(f"Agent 图片解析失败: {e}", 500)

    @app.post("/api/agent/chat")
    def api_agent_chat():
        payload = request.get_json(silent=True) or {}
        try:
            api_base = (
                payload.get("api_base")
                or os.getenv("LITELLM_API_BASE")
                or "https://litellm.shoplazza.site"
            ).strip().rstrip("/")
            api_key = (payload.get("api_key") or os.getenv("LITELLM_API_KEY") or "").strip()
            model = (payload.get("model") or os.getenv("LITELLM_MODEL") or "azure-gpt-5").strip()
            proxy = (payload.get("proxy") or "").strip()
            messages = payload.get("messages")
            prompt = (payload.get("prompt") or "").strip()
            temperature = payload.get("temperature")
            max_tokens = payload.get("max_tokens")
            top_p = payload.get("top_p")

            if not api_key:
                return json_error("agent api_key 不能为空（可通过 payload.api_key 或 LITELLM_API_KEY 提供）")
            if not model:
                return json_error("agent model 不能为空")

            if not isinstance(messages, list) or not messages:
                if not prompt:
                    return json_error("messages 或 prompt 至少提供一个")
                messages = [{"role": "user", "content": prompt}]

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
            return json_error(f"Agent Chat 调用失败: {e}", 500)

