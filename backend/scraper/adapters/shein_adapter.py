import html
import json
import re
from urllib.parse import unquote, urlparse

from shoplive.backend.scraper.adapters.generic_adapter import (
    clean_text,
    extract_review_lines,
    extract_review_signals,
    parse_generic_page,
    pick_first_non_empty,
    rank_and_filter_images,
)


def _extract_json_blocks(html_text: str):
    out = []
    for raw in re.findall(r"<script[^>]*>([\s\S]*?)</script>", html_text or "", flags=re.IGNORECASE):
        text = (raw or "").strip()
        if not text:
            continue
        if text.startswith("{") or text.startswith("["):
            out.append(text)
            continue
        for key in ["__NEXT_DATA__", "__INITIAL_STATE__", "__NUXT__", "window.gbRawData"]:
            m = re.search(rf"{re.escape(key)}\s*=\s*(\{{[\s\S]*\}}|\[[\s\S]*\])\s*;?\s*$", text)
            if m:
                out.append(m.group(1))
    return out


def _extract_shein_product_name(product_url: str, html_text: str):
    meta_title = ""
    mt = re.search(
        r'<meta[^>]+(?:property|name)=["\']og:title["\'][^>]+content=["\']([^"\']+)["\']',
        html_text or "",
        flags=re.IGNORECASE,
    )
    if mt:
        meta_title = html.unescape(mt.group(1)).strip()
    title_tag = ""
    mtitle = re.search(r"<title>([\s\S]*?)</title>", html_text or "", flags=re.IGNORECASE)
    if mtitle:
        title_tag = clean_text(mtitle.group(1))

    js_name = ""
    for p in [r'"goods_name"\s*:\s*"([^"]+)"', r'"productName"\s*:\s*"([^"]+)"', r'"goodsTitle"\s*:\s*"([^"]+)"']:
        mm = re.search(p, html_text or "", flags=re.IGNORECASE)
        if mm:
            js_name = html.unescape(mm.group(1)).strip()
            break

    slug_name = ""
    try:
        path = urlparse(product_url).path or ""
        path = unquote(path)
        mslug = re.search(r"/([^/]+)-p-\d+\.html", path, flags=re.IGNORECASE)
        if mslug:
            slug_name = mslug.group(1).replace("-", " ").strip()
    except Exception:
        slug_name = ""

    return pick_first_non_empty([js_name, meta_title, title_tag, slug_name])


def _extract_shein_image_urls(product_url: str, html_text: str):
    candidates = []
    patterns = [
        r"https://[^\"' ]*ltwebstatic[^\"' ]+\.(?:jpg|jpeg|png|webp)",
        r"https://[^\"' ]*shein[^\"' ]+\.(?:jpg|jpeg|png|webp)",
        r"https://img[^\"' ]+\.(?:jpg|jpeg|png|webp)",
    ]
    for pattern in patterns:
        for u in re.findall(pattern, html_text or "", flags=re.IGNORECASE):
            candidates.append({"url": html.unescape(u), "source": "shein_inline"})

    # Try extracting from JSON blobs where image arrays are available.
    for block in _extract_json_blocks(html_text):
        try:
            data = json.loads(block)
        except Exception:
            continue
        stack = [data]
        while stack:
            node = stack.pop()
            if isinstance(node, dict):
                for k, v in node.items():
                    if isinstance(v, str) and re.search(r"\.(jpg|jpeg|png|webp)(\?|$)", v, flags=re.IGNORECASE):
                        if "http" in v:
                            candidates.append({"url": html.unescape(v), "source": "shein_inline"})
                    elif isinstance(v, (dict, list)):
                        stack.append(v)
            elif isinstance(node, list):
                for item in node:
                    if isinstance(item, str) and re.search(r"\.(jpg|jpeg|png|webp)(\?|$)", item, flags=re.IGNORECASE):
                        if "http" in item:
                            candidates.append({"url": html.unescape(item), "source": "shein_inline"})
                    elif isinstance(item, (dict, list)):
                        stack.append(item)

    return rank_and_filter_images(candidates, product_name=_extract_shein_product_name(product_url, html_text), platform="shein", limit=12)


def _extract_shein_review_text(html_text: str):
    snippets = []
    for p in [
        r'"comment"\s*:\s*"([^"]{8,260})"',
        r'"content"\s*:\s*"([^"]{8,260})"',
        r'"reviewContent"\s*:\s*"([^"]{8,260})"',
        r'"buyer_show_desc"\s*:\s*"([^"]{8,260})"',
    ]:
        for m in re.findall(p, html_text or "", flags=re.IGNORECASE):
            s = clean_text(html.unescape(m))
            if s:
                snippets.append(s)
    text_blob = "。".join(snippets[:80])
    lines = extract_review_lines(text_blob)
    pos, neg = extract_review_signals(text_blob)
    summary = "；".join((pos[:2] + neg[:1])) if (pos or neg) else ("；".join(lines[:3]) if lines else "")
    return lines, pos, neg, summary


def parse_shein_page(product_url: str, html_text: str):
    base = parse_generic_page(product_url, html_text, platform_hint="shein")
    shein_name = _extract_shein_product_name(product_url, html_text)
    shein_images = _extract_shein_image_urls(product_url, html_text)
    review_lines, review_pos, review_neg, review_summary = _extract_shein_review_text(html_text)

    if shein_name:
        base.product_name = shein_name
    if shein_images:
        base.image_urls = shein_images
    if review_lines:
        base.review_highlights = review_lines
    if review_pos:
        base.review_positive_points = review_pos
    if review_neg:
        base.review_negative_points = review_neg
    if review_summary:
        base.review_summary = review_summary

    score = 0
    if base.product_name:
        score += 1
    if base.image_urls:
        score += 1
    if base.review_summary or base.review_positive_points or base.review_negative_points:
        score += 1
    base.confidence = "high" if score >= 3 else ("medium" if score == 2 else "low")
    base.platform = "shein"
    return base
