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
    text = html_text or ""

    # 1. High-res direct attributes
    for pattern in [
        r'data-old-hires=["\']([^"\']+)["\']',
        r'"hiRes"\s*:\s*"([^"]+)"',
        r'"large"\s*:\s*"([^"]+)"',
        r'"mainUrl"\s*:\s*"([^"]+)"',
    ]:
        for raw in re.findall(pattern, text, flags=re.IGNORECASE):
            url = html.unescape(str(raw or "").replace("\\/", "/").strip())
            if url.startswith("http"):
                candidates.append({"url": url, "source": "amazon_hires"})

    # 2. data-a-dynamic-image — JSON dict of {url: [w, h]} on #landingImage
    for raw_json in re.findall(r'data-a-dynamic-image=["\'](\{[^"\']+\})["\']', text, flags=re.IGNORECASE):
        try:
            blob = json.loads(html.unescape(raw_json))
            if isinstance(blob, dict):
                # Pick the largest dimension variant
                best_url = max(blob.keys(), key=lambda u: (blob[u] or [0, 0])[0], default=None)
                if best_url and best_url.startswith("http"):
                    candidates.append({"url": best_url, "source": "amazon_dynamic"})
                for u in blob:
                    if u.startswith("http"):
                        candidates.append({"url": u, "source": "amazon_dynamic"})
        except Exception:
            pass

    # 3. ImageBlockATF / ImageBlockBTF embedded JSON
    for block_pattern in [
        r"'colorImages'\s*:\s*(\{[\s\S]*?\})\s*,\s*'colorToAsin'",
        r'"colorImages"\s*:\s*(\{[\s\S]*?\})\s*,\s*"colorToAsin"',
        r"ImageBlockATF\s*&&\s*ImageBlockATF\.push\s*\((\{[\s\S]*?\})\)",
    ]:
        for raw_json in re.findall(block_pattern, text, flags=re.IGNORECASE):
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

    # 4. landingImageUrl in JS data
    for raw in re.findall(r'"landingImageUrl"\s*:\s*"([^"]+)"', text, flags=re.IGNORECASE):
        url = html.unescape(raw.replace("\\/", "/").strip())
        if url.startswith("http"):
            candidates.append({"url": url, "source": "amazon_hires"})

    # 5. JSON-LD product image
    for raw_json in re.findall(r'<script[^>]+type=["\']application/ld\+json["\'][^>]*>([\s\S]*?)</script>', text, flags=re.IGNORECASE):
        try:
            blob = json.loads(raw_json.strip())
            entries = blob if isinstance(blob, list) else [blob]
            for entry in entries:
                if not isinstance(entry, dict):
                    continue
                for key in ("image", "thumbnailUrl"):
                    val = entry.get(key)
                    if isinstance(val, str) and val.startswith("http"):
                        candidates.append({"url": val, "source": "amazon_jsonld"})
                    elif isinstance(val, list):
                        for v in val:
                            if isinstance(v, str) and v.startswith("http"):
                                candidates.append({"url": v, "source": "amazon_jsonld"})
        except Exception:
            pass

    # 6. Fallback: any SSL images-amazon CDN URL
    for raw in re.findall(
        r'https://[^"\'<>\s]*(?:images-na\.ssl-images-amazon\.com|m\.media-amazon\.com)[^"\'<>\s]+\.(?:jpg|jpeg|png|webp)',
        text, flags=re.IGNORECASE,
    ):
        candidates.append({"url": html.unescape(raw), "source": "amazon_cdn"})

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


def _extract_amazon_product_name(html_text: str) -> str:
    """Try #productTitle and JSON-LD name before falling back to generic."""
    text = html_text or ""
    # #productTitle span
    m = re.search(r'id=["\']productTitle["\'][^>]*>\s*([\s\S]*?)\s*</(?:span|h1)', text, re.IGNORECASE)
    if m:
        name = clean_text(html.unescape(m.group(1)))
        if name:
            return name
    # JSON-LD name
    for raw_json in re.findall(r'<script[^>]+type=["\']application/ld\+json["\'][^>]*>([\s\S]*?)</script>', text, re.IGNORECASE):
        try:
            blob = json.loads(raw_json.strip())
            entries = blob if isinstance(blob, list) else [blob]
            for entry in entries:
                if isinstance(entry, dict) and entry.get("name"):
                    name = clean_text(str(entry["name"]))
                    if name:
                        return name
        except Exception:
            pass
    return ""


def _extract_amazon_selling_points(html_text: str) -> list:
    """Extract bullet points from feature-bullets section."""
    text = html_text or ""
    bullets = []
    # Feature bullets block
    m = re.search(r'id=["\']feature-bullets["\'][\s\S]*?(<ul[\s\S]*?</ul>)', text, re.IGNORECASE)
    if m:
        for li in re.findall(r'<li[^>]*>([\s\S]*?)</li>', m.group(1), re.IGNORECASE):
            point = clean_text(html.unescape(re.sub(r'<[^>]+>', '', li)))
            if point and len(point) > 4 and "javascript" not in point.lower():
                bullets.append(point)
    # Fallback: #productDescription
    if not bullets:
        desc_m = re.search(r'id=["\']productDescription["\'][^>]*>([\s\S]*?)</div>', text, re.IGNORECASE)
        if desc_m:
            for li in re.findall(r'<li[^>]*>([\s\S]*?)</li>', desc_m.group(1), re.IGNORECASE):
                point = clean_text(html.unescape(re.sub(r'<[^>]+>', '', li)))
                if point and len(point) > 4:
                    bullets.append(point)
    return bullets[:8]


def parse_amazon_page(product_url: str, html_text: str):
    result = parse_generic_page(product_url, html_text, platform_hint="amazon")

    # Override product name with Amazon-specific extraction if better
    amazon_name = _extract_amazon_product_name(html_text)
    if amazon_name and (not result.product_name or len(amazon_name) > len(result.product_name)):
        result.product_name = amazon_name

    images = _extract_amazon_images(product_url, html_text, result.product_name)
    review_lines, review_pos, review_neg, review_summary = _extract_amazon_reviews(html_text)

    if images:
        result.image_urls = images

    # Selling points from feature bullets
    bullets = _extract_amazon_selling_points(html_text)
    if bullets and not getattr(result, "selling_points", None):
        result.selling_points = bullets

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
