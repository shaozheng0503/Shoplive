import html
import json
import re

from shoplive.backend.scraper.adapters.generic_adapter import (
    clean_text,
    extract_review_lines,
    extract_review_signals,
    parse_generic_page,
    rank_and_filter_images,
)


def _iter_values(node):
    if isinstance(node, dict):
        for value in node.values():
            yield value
            yield from _iter_values(value)
    elif isinstance(node, list):
        for value in node:
            yield value
            yield from _iter_values(value)


def _extract_json_blobs(html_text: str):
    blobs = []
    for raw in re.findall(r"<script[^>]*>([\s\S]*?)</script>", html_text or "", flags=re.IGNORECASE):
        text = (raw or "").strip()
        if not text:
            continue
        if text.startswith("{") or text.startswith("["):
            blobs.append(text)
        for key in ["__NEXT_DATA__", "__INITIAL_STATE__"]:
            match = re.search(rf"{re.escape(key)}\s*=\s*(\{{[\s\S]*\}})\s*;?\s*$", text)
            if match:
                blobs.append(match.group(1))
    return blobs


def _extract_tiktok_images(html_text: str, product_name: str):
    candidates = []
    for raw in re.findall(r'https://[^"\']*(?:tiktokcdn|ttwstatic|ibytedtos|tiktok)[^"\']+\.(?:jpg|jpeg|png|webp)[^"\']*', html_text or "", flags=re.IGNORECASE):
        candidates.append({"url": html.unescape(raw), "source": "inline"})
    for blob in _extract_json_blobs(html_text):
        try:
            data = json.loads(blob)
        except Exception:
            continue
        for value in _iter_values(data):
            if isinstance(value, str) and re.search(r"\.(jpg|jpeg|png|webp)(\?|$)", value, flags=re.IGNORECASE):
                if "http" in value:
                    candidates.append({"url": html.unescape(value), "source": "inline"})
    return rank_and_filter_images(candidates, product_name=product_name, platform="tiktok-shop", limit=12)


def _extract_tiktok_reviews(html_text: str):
    snippets = []
    for pattern in [
        r'"reviewText"\s*:\s*"([^"]{8,260})"',
        r'"comment(?:Content|Text)?"\s*:\s*"([^"]{8,260})"',
        r'"buyerReview"\s*:\s*"([^"]{8,260})"',
    ]:
        for raw in re.findall(pattern, html_text or "", flags=re.IGNORECASE):
            text = clean_text(html.unescape(raw))
            if text:
                snippets.append(text)
    blob = "。".join(snippets[:120])
    lines = extract_review_lines(blob)
    pos, neg = extract_review_signals(blob)
    summary = "；".join((pos[:2] + neg[:1])) if (pos or neg) else ("；".join(lines[:3]) if lines else "")
    return lines, pos, neg, summary


def parse_tiktok_shop_page(product_url: str, html_text: str):
    result = parse_generic_page(product_url, html_text, platform_hint="tiktok-shop")
    images = _extract_tiktok_images(html_text, result.product_name)
    review_lines, review_pos, review_neg, review_summary = _extract_tiktok_reviews(html_text)
    if images:
        result.image_urls = images
    if review_lines:
        result.review_highlights = review_lines
    if review_pos:
        result.review_positive_points = review_pos
    if review_neg:
        result.review_negative_points = review_neg
    if review_summary:
        result.review_summary = review_summary
    result.main_image_confidence = "high" if len(result.image_urls) >= 3 else ("medium" if result.image_urls else "low")
    result.review_extraction_method = "structured" if (review_lines or review_pos or review_neg) else "generic"

    score = 0
    if result.product_name:
        score += 1
    if result.image_urls:
        score += 1
    if result.review_summary or result.review_positive_points or result.review_negative_points:
        score += 1
    result.confidence = "high" if score >= 3 else ("medium" if score == 2 else "low")
    result.platform = "tiktok-shop"
    return result
