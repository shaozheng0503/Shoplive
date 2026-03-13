import re
import threading
from typing import Callable, Dict
from urllib.parse import urlparse

import requests

from shoplive.backend.scraper.models import FetchArtifact


DESKTOP_UA = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
    "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
)
MOBILE_UA = (
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) "
    "AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1"
)
DESKTOP_UA_WIN = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
    "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
)


def _is_amazon_url(url: str) -> bool:
    host = (urlparse(str(url or "")).netloc or "").lower()
    return "amazon." in host


def _normalize_amazon_url(url: str) -> str:
    """Strip tracking/affiliate params and reduce to canonical /dp/ASIN form.

    Keeps the URL clean so bot-detection systems don't flag tracking parameters,
    and also improves cache hit rate for the same product accessed via different
    affiliate/referral links.
    """
    try:
        parsed = urlparse(url)
        # Extract ASIN from /dp/ASIN or /gp/product/ASIN paths
        m = re.search(r"/(?:dp|gp/product)/([A-Z0-9]{10})", parsed.path)
        if m:
            asin = m.group(1)
            clean_path = f"/dp/{asin}"
            return f"{parsed.scheme}://{parsed.netloc}{clean_path}"
    except Exception:
        pass
    return url


def _build_amazon_headers_variants():
    desktop = {
        "User-Agent": DESKTOP_UA,
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
        "Accept-Encoding": "gzip, deflate, br",
        "Cache-Control": "no-cache",
        "Pragma": "no-cache",
        "Referer": "https://www.amazon.com/",
        "sec-ch-ua": '"Chromium";v="124", "Google Chrome";v="124", "Not-A.Brand";v="99"',
        "sec-ch-ua-mobile": "?0",
        "sec-ch-ua-platform": '"macOS"',
        "sec-fetch-dest": "document",
        "sec-fetch-mode": "navigate",
        "sec-fetch-site": "same-origin",
        "sec-fetch-user": "?1",
        "upgrade-insecure-requests": "1",
    }
    desktop_win = {
        "User-Agent": DESKTOP_UA_WIN,
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
        "Accept-Encoding": "gzip, deflate, br",
        "Cache-Control": "no-cache",
        "Pragma": "no-cache",
        "Referer": "https://www.amazon.com/",
        "sec-ch-ua": '"Chromium";v="124", "Google Chrome";v="124", "Not-A.Brand";v="99"',
        "sec-ch-ua-mobile": "?0",
        "sec-ch-ua-platform": '"Windows"',
        "sec-fetch-dest": "document",
        "sec-fetch-mode": "navigate",
        "sec-fetch-site": "none",
        "sec-fetch-user": "?1",
        "upgrade-insecure-requests": "1",
    }
    mobile = {
        "User-Agent": MOBILE_UA,
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
        "Accept-Encoding": "gzip, deflate, br",
        "Cache-Control": "no-cache",
        "Pragma": "no-cache",
        "Referer": "https://www.amazon.com/",
        "sec-fetch-dest": "document",
        "sec-fetch-mode": "navigate",
        "sec-fetch-site": "none",
        "upgrade-insecure-requests": "1",
    }
    return [desktop, desktop_win, mobile]


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
    import time as _time
    is_amazon = _is_amazon_url(product_url)
    fetch_url = _normalize_amazon_url(product_url) if is_amazon else product_url

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
        header_variants = _build_amazon_headers_variants() if is_amazon else [headers]

        for idx, req_headers in enumerate(header_variants):
            if idx > 0:
                _time.sleep(0.8)  # small back-off between UA variants
            resp = session.get(fetch_url, timeout=45, proxies=proxies, headers=req_headers, allow_redirects=True)
            html_text = resp.text or ""
            anti_bot = _is_anti_bot_page(html_text)
            failure_tag = _detect_failure_tag(html_text, anti_bot, platform=resp.url or fetch_url)
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
            url=resp.url or fetch_url,
            status_code=resp.status_code,
            html=html_text,
            anti_bot=anti_bot,
            failure_tag=failure_tag,
        )
    except Exception as e:
        return FetchArtifact(
            engine="requests",
            url=fetch_url,
            status_code=599,
            html="",
            anti_bot=False,
            error=str(e),
            failure_tag="network_error",
        )


class _PlaywrightPool:
    """Thread-local Playwright browser pool.

    Each Flask worker thread keeps its own Chromium browser alive, avoiding
    the ~2-3 s cold-start cost on every scrape call. Browsers are restarted
    automatically on crash or proxy change.

    Thread-safety note: Playwright objects must not be shared across threads.
    Using threading.local() gives each worker thread its own isolated set of
    Playwright / Browser objects — no locking needed for page operations.
    """

    def __init__(self) -> None:
        self._local = threading.local()
        self._stats_lock = threading.Lock()
        self._stats: Dict[str, int] = {"launches": 0, "reuses": 0, "crashes": 0}

    # ------------------------------------------------------------------
    # Internal helpers — must only be called from the owning thread
    # ------------------------------------------------------------------

    def _close_thread_browser(self) -> None:
        browser = getattr(self._local, "browser", None)
        if browser is not None:
            try:
                browser.close()
            except Exception:
                pass
            self._local.browser = None

    def _ensure_browser(self, proxy: str) -> None:
        """Get or create a browser for this thread; restart on proxy change or crash."""
        proxy_key = proxy or ""
        tl = self._local

        # Proxy changed → close existing and start fresh
        if getattr(tl, "proxy_key", None) != proxy_key:
            self._close_thread_browser()

        browser = getattr(tl, "browser", None)

        # Detect crashed browser
        if browser is not None:
            try:
                alive = browser.is_connected()
            except Exception:
                alive = False
            if not alive:
                tl.browser = None
                browser = None

        if browser is None:
            playwright = getattr(tl, "playwright", None)
            if playwright is None:
                from playwright.sync_api import sync_playwright as _sw
                pw_cm = _sw()
                playwright = pw_cm.__enter__()
                tl.pw_cm = pw_cm
                tl.playwright = playwright

            pw_proxy = {"server": proxy} if proxy else None
            tl.browser = playwright.chromium.launch(headless=True, proxy=pw_proxy)
            tl.proxy_key = proxy_key
            with self._stats_lock:
                self._stats["launches"] += 1
        else:
            with self._stats_lock:
                self._stats["reuses"] += 1

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    def fetch(
        self,
        url: str,
        proxy: str,
        platform: str = "",
        wait_ms: int = 2200,
    ) -> FetchArtifact:
        platform_key = str(platform or "").lower()
        render_wait_ms = max(1000, min(int(wait_ms or 2200), 12000))
        if platform_key in {"amazon", "tiktok-shop", "temu"}:
            render_wait_ms = max(render_wait_ms, 3500)

        try:
            self._ensure_browser(proxy)
        except Exception as e:
            return FetchArtifact(
                engine="playwright",
                url=url,
                status_code=599,
                html="",
                error=f"browser start failed: {e}",
                failure_tag="playwright_unavailable",
            )

        is_amazon = _is_amazon_url(url)
        fetch_url = _normalize_amazon_url(url) if is_amazon else url
        ctx_locale = "en-US" if is_amazon else "zh-CN"

        html_text = ""
        status_code = 599
        final_url = fetch_url
        context = None
        try:
            context = self._local.browser.new_context(
                user_agent=DESKTOP_UA,
                locale=ctx_locale,
                viewport={"width": 1440, "height": 900},
                extra_http_headers={
                    "Accept-Language": "en-US,en;q=0.9",
                    "sec-ch-ua": '"Chromium";v="124", "Google Chrome";v="124", "Not-A.Brand";v="99"',
                    "sec-ch-ua-mobile": "?0",
                    "sec-ch-ua-platform": '"macOS"',
                } if is_amazon else {},
            )
            page = context.new_page()

            # Block resources that are not needed for HTML extraction —
            # images, fonts, stylesheets, tracking pixels speed up page load significantly
            _BLOCK_RES = {"image", "media", "font", "stylesheet"}
            _BLOCK_HOSTS = {
                "fls-na.amazon.com", "amazon-adsystem.com",
                "doubleclick.net", "googlesyndication.com",
                "google-analytics.com", "googletagmanager.com",
            }

            def _handle_route(route):
                if route.request.resource_type in _BLOCK_RES:
                    route.abort()
                    return
                req_host = urlparse(route.request.url).hostname or ""
                if any(d in req_host for d in _BLOCK_HOSTS):
                    route.abort()
                    return
                route.continue_()

            page.route("**/*", _handle_route)

            # Stealth: mask navigator.webdriver and plugins to avoid bot detection
            page.add_init_script("""
                Object.defineProperty(navigator, 'webdriver', {get: () => undefined});
                Object.defineProperty(navigator, 'plugins', {get: () => [1,2,3,4,5]});
                Object.defineProperty(navigator, 'languages', {get: () => ['en-US','en']});
                window.chrome = {runtime: {}};
            """)
            try:
                resp = page.goto(fetch_url, wait_until="domcontentloaded", timeout=60000)
                status_code = resp.status if resp else 200
                final_url = page.url or fetch_url

                if is_amazon:
                    # Wait for product content elements before extracting HTML
                    try:
                        page.wait_for_selector(
                            "#productTitle, #landingImage, #feature-bullets",
                            timeout=12000,
                        )
                    except Exception:
                        pass
                    # Scroll to trigger lazy-loaded JS data blocks
                    page.evaluate("window.scrollTo(0, document.body.scrollHeight / 3)")
                    page.wait_for_timeout(800)
                    page.evaluate("window.scrollTo(0, 0)")
                    page.wait_for_timeout(max(render_wait_ms, 4000))
                else:
                    page.wait_for_timeout(render_wait_ms)

                html_text = page.content() or ""
            finally:
                page.close()
        except Exception as e:
            with self._stats_lock:
                self._stats["crashes"] += 1
            # Invalidate browser so next request triggers a fresh launch
            try:
                if self._local.browser and not self._local.browser.is_connected():
                    self._local.browser = None
            except Exception:
                self._local.browser = None
            return FetchArtifact(
                engine="playwright",
                url=url,
                status_code=599,
                html="",
                error=str(e),
                failure_tag="render_failed",
            )
        finally:
            if context is not None:
                try:
                    context.close()
                except Exception:
                    pass

        anti_bot = _is_anti_bot_page(html_text)
        return FetchArtifact(
            engine="playwright",
            url=final_url,
            status_code=status_code,
            html=html_text,
            anti_bot=anti_bot,
            failure_tag=_detect_failure_tag(html_text, anti_bot, platform=platform_key),
        )

    def get_stats(self) -> Dict:
        with self._stats_lock:
            return dict(self._stats)


_playwright_pool = _PlaywrightPool()


def get_playwright_pool_stats() -> Dict:
    """Return browser pool statistics (launches / reuses / crashes) for /api/health."""
    return _playwright_pool.get_stats()


def fetch_html_with_playwright(product_url: str, proxy: str, platform: str = "", wait_ms: int = 2200) -> FetchArtifact:
    # Availability check — if playwright isn't installed, return typed failure immediately.
    try:
        import playwright  # noqa: F401
    except ImportError as e:
        return FetchArtifact(
            engine="playwright",
            url=product_url,
            status_code=599,
            html="",
            error=f"playwright unavailable: {e}",
            failure_tag="playwright_unavailable",
        )
    return _playwright_pool.fetch(product_url, proxy, platform=platform, wait_ms=wait_ms)
