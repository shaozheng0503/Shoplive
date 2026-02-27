import html
import re

from shoplive.backend.scraper.adapters.generic_adapter import (
    clean_text,
    extract_review_lines,
    extract_review_signals,
    parse_generic_page,
    rank_and_filter_images,
)


def _extract_jd_images(html_text: str, product_name: str):
    candidates = []
    for pattern in [
        r'"(?:imagePath|skuImageUrl|image|imgUrl)"\s*:\s*"([^"]+\.(?:jpg|jpeg|png|webp)[^"]*)"',
        r'https://[^"\']*(?:360buyimg|jd\.com|jdimg)[^"\']+\.(?:jpg|jpeg|png|webp)[^"\']*',
    ]:
        for raw in re.findall(pattern, html_text or "", flags=re.IGNORECASE):
            candidates.append({"url": html.unescape(raw.replace("\\/", "/")), "source": "inline"})
    return rank_and_filter_images(candidates, product_name=product_name, platform="jd", limit=12)


def _extract_jd_reviews(html_text: str):
    snippets = []
    for pattern in [
        r'"content"\s*:\s*"([^"]{6,260})"',
        r'"commentData"\s*:\s*"([^"]{6,260})"',
        r'"(?:good|poor)Comment"\s*:\s*"([^"]{6,260})"',
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


def parse_jd_page(product_url: str, html_text: str):
    result = parse_generic_page(product_url, html_text, platform_hint="jd")
    m = re.search(r'"name"\s*:\s*"([^"]{4,220})"', html_text or "", flags=re.IGNORECASE)
    if m:
        result.product_name = html.unescape(m.group(1)).strip()
    images = _extract_jd_images(html_text, result.product_name)
    review_lines, review_pos, review_neg, review_summary = _extract_jd_reviews(html_text)
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
    if not result.selling_points and result.product_name:
        result.selling_points = [f"{result.product_name[:28]} 核心参数突出"]
    score = 0
    if result.product_name:
        score += 1
    if result.image_urls:
        score += 1
    if result.review_summary or result.review_positive_points or result.review_negative_points:
        score += 1
    result.confidence = "high" if score >= 3 else ("medium" if score == 2 else "low")
    result.platform = "jd"
    return result
