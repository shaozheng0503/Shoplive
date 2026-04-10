import html
import re
from typing import Callable, Dict, List, Optional
from urllib.parse import urljoin, urlparse

import requests

from shoplive.backend.infra import build_proxies

_DEFAULT_HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) "
        "AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 "
        "Mobile/15E148 Safari/604.1"
    ),
    "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
}

_DIRECT_VIDEO_HOST_HINTS = (
    "aweme.snssdk.com",
    "douyinvod.com",
    "byteimg.com",
    "bytecdn.cn",
    "bytecdntp.com",
    "ibytedtos.com",
    "xhscdn.com",
    "xiaohongshu.com",
    "sns-video-bd.xhscdn.com",
)

_SHARE_HOST_HINTS = (
    "v.douyin.com",
    "iesdouyin.com",
    "douyin.com",
    "www.douyin.com",
    "xhslink.com",
    "xhslink.cn",
    "xiaohongshu.com",
    "www.xiaohongshu.com",
)


def _decode_candidate(raw: str) -> str:
    value = html.unescape(str(raw or "").strip().strip('"').strip("'"))
    if not value:
        return ""
    replacements = {
        r"\/": "/",
        r"\u002F": "/",
        r"\u0026": "&",
        r"\u003D": "=",
        r"\u002D": "-",
    }
    for src, dst in replacements.items():
        value = value.replace(src, dst)
    if value.startswith("//"):
        value = "https:" + value
    return value.strip()


def _is_http_url(value: str) -> bool:
    try:
        parsed = urlparse(str(value or "").strip())
        return parsed.scheme in {"http", "https"} and bool(parsed.netloc)
    except Exception:
        return False


def looks_like_direct_video_url(url: str, content_type: str = "") -> bool:
    if not _is_http_url(url):
        return False
    parsed = urlparse(url)
    host = (parsed.netloc or "").lower()
    path = (parsed.path or "").lower()
    ctype = (content_type or "").lower()
    if ctype.startswith("video/"):
        return True
    if path.endswith((".mp4", ".mov", ".m4v", ".webm")):
        return True
    if any(hint in host for hint in _DIRECT_VIDEO_HOST_HINTS):
        if any(token in path for token in ("/play", "/video", "/media/", "/aweme/v1/play", "/note-video/")):
            return True
        if parsed.query and any(token in parsed.query.lower() for token in ("video_id=", "ratio=", "watermark=", "source=")):
            return True
    return False


def _normalize_candidate(candidate: str, base_url: str) -> str:
    value = _decode_candidate(candidate)
    if not value:
        return ""
    if value.startswith("/"):
        value = urljoin(base_url, value)
    if not _is_http_url(value):
        return ""
    return value


def extract_video_candidates_from_html(html_text: str, base_url: str) -> List[str]:
    source = str(html_text or "")
    if not source:
        return []
    patterns = [
        r'<meta[^>]+property=["\']og:video(?::url)?["\'][^>]+content=["\']([^"\']+)["\']',
        r'<meta[^>]+name=["\']og:video(?::url)?["\'][^>]+content=["\']([^"\']+)["\']',
        r'<meta[^>]+itemprop=["\']contentURL["\'][^>]+content=["\']([^"\']+)["\']',
        r'"playAddr"\s*:\s*"([^"]+)"',
        r'"play_addr"\s*:\s*\{[^{}]*"url_list"\s*:\s*\[\s*"([^"]+)"',
        r'"masterUrl"\s*:\s*"([^"]+)"',
        r'"h264"\s*:\s*"\s*([^"]+)"',
        r'"originVideoUrl"\s*:\s*"([^"]+)"',
        r'"videoUrl"\s*:\s*"([^"]+)"',
        r'"url"\s*:\s*"(https?:[^"]+)"',
        r'"url"\s*:\s*"(//[^"]+)"',
        r'(https?:\/\/[^\s"\'<>]+(?:\.mp4|\/aweme\/v1\/play[^\s"\'<>]*|\/note-video\/[^\s"\'<>]*))',
    ]
    seen = set()
    results: List[str] = []
    for pattern in patterns:
        for match in re.findall(pattern, source, re.IGNORECASE | re.DOTALL):
            value = _normalize_candidate(match, base_url)
            if not value or value in seen:
                continue
            seen.add(value)
            results.append(value)
    return results


def resolve_video_share_url(
    video_url: str,
    proxy: str = "",
    timeout_seconds: int = 20,
    render_html: Optional[Callable[[str, str], object]] = None,
) -> Dict[str, str]:
    raw = str(video_url or "").strip()
    if not raw:
        raise ValueError("video_url 不能为空")
    if not _is_http_url(raw):
        return {
            "input_url": raw,
            "resolved_video_url": raw,
            "resolved_page_url": raw,
            "strategy": "passthrough",
            "is_share_link": False,
        }
    if looks_like_direct_video_url(raw):
        return {
            "input_url": raw,
            "resolved_video_url": raw,
            "resolved_page_url": raw,
            "strategy": "direct",
            "is_share_link": False,
        }

    response = requests.get(
        raw,
        headers=_DEFAULT_HEADERS,
        timeout=timeout_seconds,
        proxies=build_proxies(proxy) or None,
        allow_redirects=True,
    )
    response.raise_for_status()
    final_url = str(response.url or raw).strip() or raw
    content_type = str(response.headers.get("Content-Type") or "").strip()
    if looks_like_direct_video_url(final_url, content_type):
        return {
            "input_url": raw,
            "resolved_video_url": final_url,
            "resolved_page_url": final_url,
            "strategy": "redirect_direct",
            "is_share_link": final_url != raw or any(hint in urlparse(raw).netloc.lower() for hint in _SHARE_HOST_HINTS),
        }

    host = (urlparse(final_url).netloc or "").lower()
    html_text = response.text or ""
    candidates = extract_video_candidates_from_html(html_text, final_url)
    for candidate in candidates:
        if looks_like_direct_video_url(candidate):
            return {
                "input_url": raw,
                "resolved_video_url": candidate,
                "resolved_page_url": final_url,
                "strategy": "html_extract",
                "is_share_link": final_url != raw or any(hint in host for hint in _SHARE_HOST_HINTS),
            }

    unresolved = {
        "input_url": raw,
        "resolved_video_url": final_url,
        "resolved_page_url": final_url,
        "strategy": "unresolved_page",
        "is_share_link": final_url != raw or any(hint in host for hint in _SHARE_HOST_HINTS),
    }
    should_try_render = bool(render_html) and unresolved["is_share_link"]
    if should_try_render:
        try:
            rendered = render_html(final_url, proxy)
        except Exception:
            rendered = None
        rendered_html = str(getattr(rendered, "html", "") or "")
        rendered_url = str(getattr(rendered, "url", "") or final_url).strip() or final_url
        if rendered_html:
            rendered_candidates = extract_video_candidates_from_html(rendered_html, rendered_url)
            for candidate in rendered_candidates:
                if looks_like_direct_video_url(candidate):
                    return {
                        "input_url": raw,
                        "resolved_video_url": candidate,
                        "resolved_page_url": rendered_url,
                        "strategy": "rendered_html_extract",
                        "is_share_link": True,
                    }
    return unresolved
