from typing import Callable, Dict
from urllib.parse import urlparse

import requests

from shoplive.backend.scraper.models import FetchArtifact


DESKTOP_UA = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
    "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36"
)
MOBILE_UA = (
    "Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) "
    "AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1"
)


def _is_amazon_url(url: str) -> bool:
    host = (urlparse(str(url or "")).netloc or "").lower()
    return "amazon." in host


def _build_amazon_headers_variants():
    desktop = {
        "User-Agent": DESKTOP_UA,
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9,zh-CN;q=0.7",
        "Cache-Control": "no-cache",
        "Pragma": "no-cache",
        "Referer": "https://www.amazon.com/",
    }
    mobile = {
        "User-Agent": MOBILE_UA,
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
        "Cache-Control": "no-cache",
        "Pragma": "no-cache",
        "Referer": "https://www.amazon.com/",
    }
    return [desktop, mobile]


def _is_anti_bot_page(html_text: str) -> bool:
    text = (html_text or "").lower()
    strong_flags = [
        "pardon our interruption",
        "robot check",
        "verify you are human",
        "access denied",
        "service unavailable",
        "are you a human",
        "captcha",
    ]
    if any(k in text for k in strong_flags):
        return True
    weak_flags = [
        "cf-chl",
        "/challenge-platform/",
        "hcaptcha",
        "g-recaptcha",
        "unusual traffic",
        "automated access",
        "bot detection",
    ]
    hits = 0
    for k in weak_flags:
        if k in text:
            hits += 1
    return hits >= 2


def is_weak_amazon_html(html_text: str) -> bool:
    text = (html_text or "").lower()
    if not text:
        return True
    anti_bot_cues = [
        "pardon our interruption",
        "robot check",
        "captcha",
        "automated access",
    ]
    if any(k in text for k in anti_bot_cues):
        return True
    weak_markers = ["fls-na.amazon.com", "amazon-adsystem.com", "oc-csi/1/op/requestid"]
    product_markers = [
        "feature-bullets",
        "producttitle",
        "landingimageurl",
        "twister",
        "imageblock",
        "dpaodetailfeaturediv",
        "\"asin\"",
    ]
    has_weak_markers = any(k in text for k in weak_markers)
    has_product_markers = any(k in text for k in product_markers)
    # Amazon often serves a very small tracking-only HTML when blocked.
    if has_weak_markers and not has_product_markers:
        return True
    return len(text) < 9000 and not has_product_markers


def _detect_failure_tag(html_text: str, anti_bot: bool, platform: str = "") -> str:
    text = (html_text or "").lower()
    if anti_bot:
        return "anti_bot"
    platform_key = str(platform or "").strip().lower()
    if ("amazon" in platform_key) and is_weak_amazon_html(text):
        return "weak_html"
    if "enable javascript" in text or "javascript is required" in text:
        return "js_required"
    if "please wait while we check your browser" in text or "checking if the site connection is secure" in text:
        return "js_challenge"
    if "not available in your region" in text or "geo-restricted" in text:
        return "geo_blocked"
    return ""


def fetch_html_with_requests(product_url: str, proxy: str, build_proxies: Callable[[str], Dict[str, str]]) -> FetchArtifact:
    headers = {
        "User-Agent": DESKTOP_UA,
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
        "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
        "Cache-Control": "no-cache",
        "Pragma": "no-cache",
    }
    proxies = build_proxies(proxy)
    try:
        session = requests.Session()
        response_candidates = []
        if _is_amazon_url(product_url):
            header_variants = _build_amazon_headers_variants()
        else:
            header_variants = [headers]

        for req_headers in header_variants:
            resp = session.get(product_url, timeout=45, proxies=proxies, headers=req_headers, allow_redirects=True)
            html_text = resp.text or ""
            anti_bot = _is_anti_bot_page(html_text)
            failure_tag = _detect_failure_tag(html_text, anti_bot, platform=resp.url or product_url)
            response_candidates.append((resp, html_text, anti_bot, failure_tag))
            if resp.status_code < 400 and failure_tag not in {"anti_bot", "weak_html", "js_challenge"}:
                break

        resp, html_text, anti_bot, failure_tag = response_candidates[-1]
        for cand_resp, cand_html, cand_anti_bot, cand_failure in response_candidates:
            if cand_resp.status_code < 400 and cand_failure not in {"anti_bot", "weak_html", "js_challenge"}:
                resp, html_text, anti_bot, failure_tag = cand_resp, cand_html, cand_anti_bot, cand_failure
                break
        return FetchArtifact(
            engine="requests",
            url=resp.url or product_url,
            status_code=resp.status_code,
            html=html_text,
            anti_bot=anti_bot,
            failure_tag=failure_tag,
        )
    except Exception as e:
        return FetchArtifact(
            engine="requests",
            url=product_url,
            status_code=599,
            html="",
            anti_bot=False,
            error=str(e),
            failure_tag="network_error",
        )


def fetch_html_with_playwright(product_url: str, proxy: str, platform: str = "", wait_ms: int = 2200) -> FetchArtifact:
    # Optional dependency; if unavailable we return a typed failure and let caller fallback.
    try:
        from playwright.sync_api import sync_playwright
    except Exception as e:
        return FetchArtifact(
            engine="playwright",
            url=product_url,
            status_code=599,
            html="",
            error=f"playwright unavailable: {e}",
            failure_tag="playwright_unavailable",
        )

    pw_proxy = None
    if proxy:
        pw_proxy = {"server": proxy}
    platform_key = str(platform or "").strip().lower()
    render_wait_ms = max(1000, min(int(wait_ms or 2200), 12000))
    if platform_key in {"amazon", "tiktok-shop", "temu"}:
        render_wait_ms = max(render_wait_ms, 3500)
    try:
        with sync_playwright() as p:
            browser = p.chromium.launch(headless=True, proxy=pw_proxy)
            context = browser.new_context(
                user_agent=DESKTOP_UA,
                locale="zh-CN",
                viewport={"width": 1365, "height": 1024},
            )
            page = context.new_page()
            resp = page.goto(product_url, wait_until="domcontentloaded", timeout=60000)
            page.wait_for_timeout(render_wait_ms)
            html_text = page.content() or ""
            status_code = resp.status if resp else 200
            final_url = page.url or product_url
            context.close()
            browser.close()
            anti_bot = _is_anti_bot_page(html_text)
            return FetchArtifact(
                engine="playwright",
                url=final_url,
                status_code=status_code,
                html=html_text,
                anti_bot=anti_bot,
                failure_tag=_detect_failure_tag(html_text, anti_bot, platform=platform_key),
            )
    except Exception as e:
        return FetchArtifact(
            engine="playwright",
            url=product_url,
            status_code=599,
            html="",
            error=str(e),
            failure_tag="render_failed",
        )
