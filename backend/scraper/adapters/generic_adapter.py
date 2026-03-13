import html
import json
import re
from urllib.parse import unquote, urljoin, urlparse

from shoplive.backend.scraper.models import ParseResult


def pick_first_non_empty(candidates):
    for item in candidates:
        text = str(item or "").strip()
        if text:
            return text
    return ""


def derive_name_from_url(product_url: str):
    try:
        path = unquote(urlparse(product_url).path or "")
        chunk = ""
        for part in reversed(path.split("/")):
            p = (part or "").strip()
            if p and p not in {"item.htm", "item.html", "goods.html", "dp"}:
                chunk = p
                break
        if not chunk:
            return ""
        chunk = re.sub(r"\.(html|htm)$", "", chunk, flags=re.IGNORECASE)
        chunk = re.sub(r"[-_]+", " ", chunk)
        chunk = re.sub(r"\bid\b\s*[:=]?\s*\d+\b", " ", chunk, flags=re.IGNORECASE)
        chunk = re.sub(r"\s+", " ", chunk).strip(" /?&=")
        if len(chunk) < 3:
            return ""
        return chunk[:80]
    except Exception:
        return ""


def clean_text(raw: str):
    text = re.sub(r"<script[\s\S]*?</script>", " ", raw or "", flags=re.IGNORECASE)
    text = re.sub(r"<style[\s\S]*?</style>", " ", text, flags=re.IGNORECASE)
    text = re.sub(r"<[^>]+>", " ", text)
    text = html.unescape(text)
    text = re.sub(r"\s+", " ", text).strip()
    return text


def guess_platform(product_url: str):
    host = (urlparse(product_url).netloc or "").lower()
    if "shein." in host:
        return "shein"
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
    if "taobao." in host or "tmall." in host:
        return "taobao"
    if "jd." in host or "jingdong." in host:
        return "jd"
    return "generic"


def is_anti_bot_page(html_text: str):
    text = (html_text or "").lower()
    title = ""
    mt = re.search(r"<title>([\s\S]*?)</title>", html_text or "", flags=re.IGNORECASE)
    if mt:
        title = clean_text(mt.group(1)).lower()
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


def _extract_meta(html_text: str, key: str):
    m = re.search(
        rf'<meta[^>]+(?:property|name)=["\']{re.escape(key)}["\'][^>]+content=["\']([^"\']+)["\']',
        html_text or "",
        flags=re.IGNORECASE,
    )
    return html.unescape(m.group(1)).strip() if m else ""


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


def _score_image_url(url: str, *, source: str, product_name: str, platform: str):
    low = (url or "").lower()
    score = 0
    source_weight = {
        "jsonld": 90,
        "amazon_jsonld": 88,
        "inline": 80,
        "amazon_hires": 95,
        "amazon_dynamic": 92,
        "amazon_cdn": 50,
        "meta": 40,
        "html_img": 10,
        "shein_inline": 90,
    }
    score += source_weight.get(source, 0)
    if re.search(r"\.(jpg|jpeg|png|webp)(\?|$)", low):
        score += 8
    if any(
        k in low
        for k in [
            "logo",
            "sprite",
            "icon",
            "favicon",
            "avatar",
            "banner",
            "header",
            "footer",
            "prime",
            "badge",
            "flag",
            "nav",
            "menu",
            "thumbnail",
            "thumb",
            "swatch",
            "placeholder",
        ]
    ):
        score -= 120
    if any(k in low for k in ["product", "main", "gallery", "large", "original", "zoom", "detail", "hero", "pdp", "sl1500", "sl1200", "ac_sl"]):
        score += 20
    if platform == "amazon":
        amazon_cdn_domains = (
            "images-na.ssl-images-amazon.com",
            "m.media-amazon.com",
            "images-eu.ssl-images-amazon.com",
            "images-fe.ssl-images-amazon.com",
        )
        if any(d in low for d in amazon_cdn_domains):
            score += 55
        else:
            score -= 40
        if any(k in low for k in ["_ac_sl", "_sl1500_", "_ul1500_", "_sx", "_sy", "landing"]):
            score += 20
        if any(k in low for k in ["sprite", "pixel", "fls-na.amazon", "amazon-adsystem", "nav", "icon", "logo"]):
            score -= 120
    if platform == "tiktok-shop":
        if any(k in low for k in ["tiktokcdn", "ttwstatic", "ibyteimg", "ibytedtos"]):
            score += 30
        if "avatar" in low or "profile" in low:
            score -= 80
    if platform == "taobao":
        if any(k in low for k in ["alicdn", "taobao", "tmall"]):
            score += 24
        if any(k in low for k in ["tbskip", "rate", "shoplogo"]):
            score -= 70
    if platform == "jd":
        if any(k in low for k in ["360buyimg", "jdimg", "jd.com"]):
            score += 24
        if any(k in low for k in ["jfs/t1", "sku", "n0"]):
            score += 10
        if any(k in low for k in ["comment", "icon", "logo"]):
            score -= 60
    words = [w for w in re.split(r"[\s\-_,/]+", (product_name or "").lower()) if len(w) >= 3][:8]
    if words and any(w in low for w in words):
        score += 10
    return score


def rank_and_filter_images(candidates, *, product_name: str, platform: str, limit: int = 10):
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


def extract_review_lines(text: str):
    chunks = re.split(r"[。！？\n\r.!?]", text or "")
    out = []
    for c in chunks:
        s = re.sub(r"\s+", " ", c).strip()
        if len(s) < 8 or len(s) > 140:
            continue
        low = s.lower()
        if any(k in low for k in ["review", "rating", "star", "comment"]) or any(k in s for k in ["评论", "评价", "买家", "好评", "差评", "星"]):
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


def extract_review_signals(text: str):
    chunks = re.split(r"[。！？\n\r.!?]", text or "")
    pos_kw = ["好评", "推荐", "满意", "喜欢", "舒适", "柔软", "质感", "耐用", "great", "love", "excellent", "comfortable", "quality", "recommend", "durable"]
    neg_kw = ["差评", "退货", "掉色", "起球", "偏小", "偏大", "慢", "问题", "bad", "poor", "return", "small", "large", "slow", "issue", "problem", "disappoint"]
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


def _build_confidence(result: ParseResult):
    score = 0
    if result.product_name:
        score += 2
    if result.image_urls:
        score += 2
    if result.selling_points:
        score += 1
    if result.review_summary:
        score += 1
    if result.main_image_confidence == "high":
        score += 1
    if score >= 3:
        return "high"
    if score == 2:
        return "medium"
    return "low"


def assess_parse_quality(result: ParseResult):
    score = 0
    if result.product_name:
        score += 5
    score += min(len(result.image_urls), 3) * 2
    score += min(len(result.selling_points), 2)
    score += min(len(result.review_positive_points) + len(result.review_negative_points), 2)
    if result.review_summary:
        score += 1
    return score


def _build_fallback_selling_points(product_name: str):
    name = str(product_name or "").strip()
    if not name:
        return []
    tokens = [t for t in re.split(r"[\s\-_/|,，。·]+", name) if len(t) >= 2]
    if not tokens:
        return []
    first = " ".join(tokens[:2])[:36]
    return [f"{first} 核心卖点突出".strip()]


def parse_generic_page(product_url: str, html_text: str, platform_hint: str = "generic"):
    platform = platform_hint or guess_platform(product_url)
    product_ld = _extract_product_jsonld(html_text)
    product_candidates = _extract_product_like_from_inline_json(html_text)
    product_inline = product_candidates[0] if product_candidates else {}
    meta_title = _extract_meta(html_text, "og:title")
    meta_desc = _extract_meta(html_text, "og:description")
    meta_image = _extract_meta(html_text, "og:image")
    title_tag = ""
    title_m = re.search(r"<title>([\s\S]*?)</title>", html_text, flags=re.IGNORECASE)
    if title_m:
        title_tag = clean_text(title_m.group(1))

    product_name = pick_first_non_empty(
        [
            product_ld.get("name", ""),
            product_inline.get("title", ""),
            product_inline.get("name", ""),
            meta_title,
            title_tag,
            derive_name_from_url(product_url),
        ]
    )
    description = pick_first_non_empty(
        [
            product_ld.get("description", ""),
            product_inline.get("description", ""),
            product_inline.get("body_html", ""),
            meta_desc,
        ]
    )
    description_plain = clean_text(description)

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
    images = rank_and_filter_images(
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
            if len(s) < 5 or len(s) > 100:
                continue
            selling_points.append(s)
            if len(selling_points) >= 6:
                break
    if not selling_points:
        selling_points = _build_fallback_selling_points(product_name)

    page_text = clean_text(html_text)
    review_lines = extract_review_lines(page_text)
    review_pos, review_neg = extract_review_signals(page_text)
    review_summary = "；".join((review_pos[:2] + review_neg[:1])) if (review_pos or review_neg) else ("；".join(review_lines[:3]) if review_lines else "")

    offers = product_ld.get("offers") if isinstance(product_ld, dict) else {}
    if isinstance(offers, list):
        offers = offers[0] if offers else {}
    price = ""
    currency = ""
    if isinstance(offers, dict):
        price = str(offers.get("price") or "").strip()
        currency = str(offers.get("priceCurrency") or "").strip()

    main_image_confidence = "low"
    if len(images) >= 3:
        main_image_confidence = "high"
    elif images:
        main_image_confidence = "medium"
    review_extraction_method = "signals" if (review_pos or review_neg) else ("highlights" if review_lines else "generic")

    result = ParseResult(
        platform=platform,
        product_name=product_name,
        description=description_plain,
        image_urls=images,
        selling_points=selling_points,
        review_highlights=review_lines,
        review_positive_points=review_pos,
        review_negative_points=review_neg,
        review_summary=review_summary,
        price=price,
        currency=currency,
        main_image_confidence=main_image_confidence,
        review_extraction_method=review_extraction_method,
    )
    result.confidence = _build_confidence(result)
    return result
