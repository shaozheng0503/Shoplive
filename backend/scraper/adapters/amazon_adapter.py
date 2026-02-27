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


def _extract_amazon_images(product_url: str, html_text: str, product_name: str):
    candidates = []
    for pattern in [
        r'data-old-hires=["\']([^"\']+)["\']',
        r'"hiRes"\s*:\s*"([^"]+)"',
        r'"large"\s*:\s*"([^"]+)"',
        r'"mainUrl"\s*:\s*"([^"]+)"',
    ]:
        for raw in re.findall(pattern, html_text or "", flags=re.IGNORECASE):
            url = html.unescape(str(raw or "").replace("\\/", "/").strip())
            if url.startswith("http"):
                candidates.append({"url": url, "source": "amazon_hires"})

    # Amazon variant blocks often carry image dictionaries.
    for raw_json in re.findall(r'"colorImages"\s*:\s*(\{[\s\S]*?\})\s*,\s*"colorToAsin"', html_text or "", flags=re.IGNORECASE):
        try:
            blob = json.loads(raw_json)
        except Exception:
            continue
        if not isinstance(blob, dict):
            continue
        for _, imgs in blob.items():
            if not isinstance(imgs, list):
                continue
            for item in imgs:
                if not isinstance(item, dict):
                    continue
                for key in ("hiRes", "large", "mainUrl"):
                    url = html.unescape(str(item.get(key) or "").replace("\\/", "/").strip())
                    if url.startswith("http"):
                        candidates.append({"url": url, "source": "amazon_hires"})

    for raw in re.findall(r'"landingImageUrl"\s*:\s*"([^"]+)"', html_text or "", flags=re.IGNORECASE):
        url = html.unescape(raw.replace("\\/", "/").strip())
        if url.startswith("http"):
            candidates.append({"url": url, "source": "amazon_hires"})

    for raw in re.findall(r'https://[^"\']*images-na\.ssl-images-amazon\.com[^"\']+\.(?:jpg|jpeg|png|webp)[^"\']*', html_text or "", flags=re.IGNORECASE):
        candidates.append({"url": html.unescape(raw), "source": "amazon_hires"})

    return rank_and_filter_images(candidates, product_name=product_name, platform="amazon", limit=12)


def _extract_amazon_reviews(html_text: str):
    snippets = []
    structured = []

    cr_state_match = re.search(r'id=["\']cr-state-object["\'][^>]+data-state=["\']([^"\']+)["\']', html_text or "", flags=re.IGNORECASE)
    if cr_state_match:
        try:
            state = json.loads(html.unescape(cr_state_match.group(1)))
            if isinstance(state, dict):
                for key in ("reviewText", "reviewBody"):
                    raw = clean_text(str(state.get(key) or ""))
                    if raw:
                        structured.append(raw)
        except Exception:
            pass

    for pattern in [
        r'<span[^>]+data-hook=["\']review-body["\'][^>]*>([\s\S]*?)</span>',
        r'<div[^>]+data-hook=["\']review-collapsed["\'][^>]*>([\s\S]*?)</div>',
        r'"reviewText"\s*:\s*"([^"]{8,300})"',
        r'"reviewBody"\s*:\s*"([^"]{8,300})"',
    ]:
        for raw in re.findall(pattern, html_text or "", flags=re.IGNORECASE):
            text = clean_text(html.unescape(raw))
            if text:
                snippets.append(text)

    blob = "。".join((structured + snippets)[:160])
    lines = extract_review_lines(blob)
    pos, neg = extract_review_signals(blob)
    summary = "；".join((pos[:2] + neg[:1])) if (pos or neg) else ("；".join(lines[:3]) if lines else "")
    return lines, pos, neg, summary


def parse_amazon_page(product_url: str, html_text: str):
    result = parse_generic_page(product_url, html_text, platform_hint="amazon")
    images = _extract_amazon_images(product_url, html_text, result.product_name)
    review_lines, review_pos, review_neg, review_summary = _extract_amazon_reviews(html_text)
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
    result.platform = "amazon"
    return result
