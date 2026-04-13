import base64
import json
import logging
import os
import random
import re
import shutil
import subprocess
import tempfile
import threading
import time
from functools import lru_cache
from pathlib import Path
from typing import Any, Dict, Iterator, List, Optional, Tuple
from urllib.parse import urlparse

logger = logging.getLogger(__name__)

import requests
from flask import jsonify
from google.cloud import storage
from google.oauth2 import service_account
from requests import Response

from shoplive.backend.infra import (
    build_proxies,
    build_proxy_candidates,
    get_access_token,
    parse_common_payload,
)

MAX_INLINE_VIDEO_B64_CHARS = 40 * 1024 * 1024
MAX_INLINE_VIDEO_BYTES = 30 * 1024 * 1024

_GENERIC_VIDEO_UA = (
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) "
    "AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 "
    "Mobile/15E148 Safari/604.1"
)
_DOUYIN_ANDROID_UA = (
    "Mozilla/5.0 (Linux; Android 13; Pixel 7) "
    "AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/123.0.0.0 Mobile Safari/537.36"
)


def _video_download_header_candidates(video_url: str) -> List[Dict[str, str]]:
    raw = str(video_url or "").strip()
    host = (urlparse(raw).netloc or "").lower()
    headers: List[Dict[str, str]] = [{
        "User-Agent": _GENERIC_VIDEO_UA,
        "Accept": "*/*",
        "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
    }]
    if any(token in host for token in ("douyinvod.com", "aweme.snssdk.com", "iesdouyin.com", "douyin.com")):
        headers[0]["Referer"] = "https://www.iesdouyin.com/"
        headers.append({
            "User-Agent": _DOUYIN_ANDROID_UA,
            "Accept": "*/*",
            "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
            "Referer": "https://www.iesdouyin.com/",
            "Range": "bytes=0-",
        })
    elif any(token in host for token in ("xhscdn.com", "xiaohongshu.com", "xhslink.com")):
        headers[0]["Referer"] = "https://www.xiaohongshu.com/"
    return headers


# ---------------------------------------------------------------------------
# Structured error handling (Article: "构建自我修复能力，而不是直接终止")
# ---------------------------------------------------------------------------

def json_error(
    message: str,
    status_code: int = 400,
    recovery_suggestion: Optional[str] = None,
    error_code: Optional[str] = None,
) -> Tuple:
    """Return a structured error response with optional recovery guidance.

    Following the article's principle: tools should not terminate on errors,
    but guide the Agent to adjust its strategy with actionable suggestions.
    """
    body: Dict[str, Any] = {"ok": False, "error": message}
    if error_code:
        body["error_code"] = error_code
    if recovery_suggestion:
        body["recovery_suggestion"] = recovery_suggestion
    return jsonify(body), status_code


# Pre-defined recovery suggestions for common error scenarios
RECOVERY_HINTS = {
    "missing_product_url": "Provide a valid product_url starting with http:// or https://. "
                           "Supported platforms: Amazon, Shein, Taobao, JD, Temu, Aliexpress, TikTok Shop, Etsy, Ebay, Walmart.",
    "missing_image": "Provide at least one of: image_items (list of {base64, mime_type}), "
                     "image_base64 (base64 string), or image_url (HTTP URL).",
    "missing_api_key": "Set api_key in the request payload or configure LITELLM_API_KEY environment variable.",
    "missing_prompt": "Provide a 'prompt' field with descriptive text for generation.",
    "invalid_duration": "duration_seconds must be 4, 6, or 8. For longer videos, use chain mode with target_total_seconds: 16 or 24.",
    "invalid_gcs_uri": "Provide a valid GCS URI starting with 'gs://'. Example: 'gs://my-bucket/videos/'",
    "ffmpeg_missing": "Install ffmpeg: brew install ffmpeg (macOS) or apt install ffmpeg (Linux).",
    "video_download_failed": "Check that video_url is accessible. Try with a proxy if the URL is behind a firewall.",
    "scrape_failed": "The product page may have anti-bot protection. Try a different proxy or use image-insight instead.",
    "veo_timeout": "The video generation timed out. Try reducing duration_seconds or simplifying the prompt.",
    "category_mismatch": "The generated image doesn't match the expected product category. "
                         "Refine product_name and main_category to be more specific.",
    "key_file_missing": "Set GOOGLE_APPLICATION_CREDENTIALS env var or provide key_file in the request payload.",
    "token_failed": "Failed to authenticate with Google Cloud. Check key_file permissions and network/proxy settings.",
}


def fetch_image_as_base64(image_url: str, proxy: str) -> Tuple[str, str]:
    resp = requests.get(image_url, timeout=60, proxies=build_proxies(proxy))
    resp.raise_for_status()
    content_type = resp.headers.get("content-type", "image/png").split(";")[0].strip()
    if content_type not in {"image/png", "image/jpeg"}:
        content_type = "image/png"
    b64 = base64.b64encode(resp.content).decode("utf-8")
    return b64, content_type


def normalize_reference_urls(raw) -> list:
    if isinstance(raw, list):
        return [str(x).strip() for x in raw if str(x).strip()]
    if isinstance(raw, str):
        txt = raw.replace("\n", ",")
        return [x.strip() for x in txt.split(",") if x.strip()]
    return []


def parse_data_url(data_url: str) -> Tuple[str, str]:
    m = re.match(r"^data:(image\/(?:png|jpeg));base64,(.+)$", data_url, re.IGNORECASE)
    if not m:
        raise ValueError("本地图片格式无效，仅支持 data:image/png 或 data:image/jpeg")
    return m.group(2), m.group(1).lower()


def parse_generic_data_url(data_url: str, accepted_prefix: str) -> Tuple[str, str]:
    m = re.match(rf"^data:({accepted_prefix}\/[a-zA-Z0-9.+-]+);base64,(.+)$", data_url, re.IGNORECASE)
    if not m:
        raise ValueError(f"无效 data URL，期望 {accepted_prefix}/*")
    return m.group(2), m.group(1).lower()


# Zero-width / invisible Unicode chars that survive the ord<32 filter but confuse
# ffmpeg's drawtext parser (RTL marks, BOM, zero-width joiners, etc.).
# Defined at module level so the frozenset is built once, not per call.
_DRAWTEXT_ZERO_WIDTH = frozenset(
    "\u200b\u200c\u200d\u200e\u200f"  # ZW space, NJ, J, LRM, RLM
    "\ufeff\u2060\u2061\u2062\u2063"  # BOM, word-joiner, invisible operators
    "\u034f"                           # combining grapheme joiner
)


def escape_drawtext_text(value: str) -> str:
    txt = str(value or "")
    # Keep \n so it can be converted to literal \n below; allow \t; strip the rest < 32
    txt = "".join(
        c for c in txt
        if (ord(c) >= 32 and c not in _DRAWTEXT_ZERO_WIDTH) or c in ("\t", "\n")
    )
    txt = txt.replace("\\", "\\\\")
    txt = txt.replace(":", "\\:")
    txt = txt.replace("'", "\\'")
    txt = txt.replace('"', '\\"')   # double-quotes break drawtext filter string
    txt = txt.replace("%", "\\%")
    txt = txt.replace("\n", "\\n")  # must be AFTER strip (strip kept \n for this step)
    return txt


def download_video_to_file(video_url: str, output_file: Path, proxy: str):
    raw = str(video_url or "").strip()
    if not raw:
        raise ValueError("video_url 不能为空")
    if raw.startswith("data:video/"):
        b64, _ = parse_generic_data_url(raw, "video")
        if len(b64) > MAX_INLINE_VIDEO_B64_CHARS:
            raise ValueError("video_url data:video 体积过大")
        try:
            decoded = base64.b64decode(b64, validate=True)
        except Exception as e:
            raise ValueError(f"video_url data:video base64 无效: {e}") from e
        if len(decoded) > MAX_INLINE_VIDEO_BYTES:
            raise ValueError("video_url data:video 解码后体积过大")
        output_file.write_bytes(decoded)
        return
    if raw.startswith("http://") or raw.startswith("https://"):
        _MAX_VIDEO_BYTES = 2 * 1024 * 1024 * 1024  # 2 GB hard cap
        last_error = None
        resp = None
        for headers in _video_download_header_candidates(raw):
            try:
                resp = requests.get(
                    raw,
                    timeout=180,
                    proxies=build_proxies(proxy),
                    stream=True,
                    headers=headers,
                    allow_redirects=True,
                )
                resp.raise_for_status()
                break
            except Exception as exc:
                last_error = exc
                resp = None
        if resp is None:
            raise last_error or RuntimeError("视频下载失败")
        content_length = int(resp.headers.get("Content-Length") or 0)
        if content_length and content_length > _MAX_VIDEO_BYTES:
            raise ValueError(f"视频文件过大 ({content_length / 1e9:.1f} GB)，超出下载上限 2 GB")
        downloaded = 0
        with output_file.open("wb") as f:
            for chunk in resp.iter_content(chunk_size=1024 * 256):
                if chunk:
                    downloaded += len(chunk)
                    if downloaded > _MAX_VIDEO_BYTES:
                        raise ValueError("视频下载中途超出大小上限 2 GB")
                    f.write(chunk)
        return
    raise ValueError("video_url 仅支持 http(s) 或 data:video/* base64")


def normalize_reference_images_base64(raw) -> List[Dict[str, str]]:
    result = []
    if not raw:
        return result
    if isinstance(raw, list):
        for item in raw:
            if not isinstance(item, dict):
                continue
            b64 = str(item.get("base64", "")).strip()
            mime = str(item.get("mime_type", "image/png")).strip()
            if b64 and mime in {"image/png", "image/jpeg"}:
                result.append({"base64": b64, "mime_type": mime})
    return result


def extract_banana_urls(data: Dict) -> list:
    urls = []
    if not isinstance(data, dict):
        return urls
    if isinstance(data.get("data"), dict):
        if isinstance(data["data"].get("url"), str):
            urls.append(data["data"]["url"])
        if isinstance(data["data"].get("urls"), list):
            urls.extend([u for u in data["data"]["urls"] if isinstance(u, str)])
        if isinstance(data["data"].get("images"), list):
            for item in data["data"]["images"]:
                if isinstance(item, str):
                    urls.append(item)
                elif isinstance(item, dict) and isinstance(item.get("url"), str):
                    urls.append(item["url"])
    if isinstance(data.get("url"), str):
        urls.append(data["url"])
    if isinstance(data.get("urls"), list):
        urls.extend([u for u in data["urls"] if isinstance(u, str)])
    seen = set()
    result = []
    for u in urls:
        if u not in seen:
            seen.add(u)
            result.append(u)
    return result


def extract_imagen_images(data: Dict) -> list:
    images = []
    predictions = data.get("predictions", []) if isinstance(data, dict) else []
    if not isinstance(predictions, list):
        return images
    for p in predictions:
        if not isinstance(p, dict):
            continue
        b64 = None
        mime = "image/png"
        if isinstance(p.get("bytesBase64Encoded"), str):
            b64 = p["bytesBase64Encoded"]
            if isinstance(p.get("mimeType"), str):
                mime = p["mimeType"]
        if not b64 and isinstance(p.get("image"), dict):
            img = p["image"]
            if isinstance(img.get("bytesBase64Encoded"), str):
                b64 = img["bytesBase64Encoded"]
            if isinstance(img.get("mimeType"), str):
                mime = img["mimeType"]
        if b64:
            images.append(
                {
                    "mime_type": mime or "image/png",
                    "base64": b64,
                    "data_url": f"data:{mime or 'image/png'};base64,{b64}",
                }
            )
    return images


def extract_chat_content(data: Dict) -> str:
    if not isinstance(data, dict):
        return ""
    choices = data.get("choices")
    if not isinstance(choices, list) or not choices:
        return ""
    first = choices[0] if isinstance(choices[0], dict) else {}
    message = first.get("message") if isinstance(first.get("message"), dict) else {}
    content = message.get("content")
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts = []
        for item in content:
            if isinstance(item, str):
                parts.append(item)
            elif isinstance(item, dict) and isinstance(item.get("text"), str):
                parts.append(item["text"])
        return "\n".join([p for p in parts if p])
    return ""


def extract_vertex_text(data: Dict[str, Any]) -> str:
    if not isinstance(data, dict):
        return ""
    candidates = data.get("candidates")
    if not isinstance(candidates, list) or not candidates:
        return ""
    first = candidates[0] if isinstance(candidates[0], dict) else {}
    content = first.get("content") if isinstance(first.get("content"), dict) else {}
    parts = content.get("parts")
    if not isinstance(parts, list):
        return ""
    out: List[str] = []
    for part in parts:
        if isinstance(part, dict) and isinstance(part.get("text"), str):
            out.append(part["text"])
    return "\n".join([x for x in out if x]).strip()


def try_parse_json_object(text: str) -> Dict[str, Any]:
    raw = (text or "").strip()
    if not raw:
        return {}
    fenced = re.search(r"```(?:json)?\s*([\s\S]*?)```", raw, re.IGNORECASE)
    if fenced:
        raw = fenced.group(1).strip()
    try:
        obj = json.loads(raw)
        return obj if isinstance(obj, dict) else {}
    except Exception:
        pass
    block = re.search(r"\{[\s\S]*\}", raw)
    if not block:
        return {}
    try:
        obj = json.loads(block.group(0))
        return obj if isinstance(obj, dict) else {}
    except Exception:
        return {}


def parse_category_judge_text(text: str) -> Dict[str, Any]:
    raw = (text or "").strip()
    if not raw:
        return {
            "ok": False,
            "is_match": True,
            "detected_category": "",
            "confidence": None,
            "reason": "empty_judge_result",
            "raw": "",
        }
    match_line = re.search(r"MATCH\s*:\s*(YES|NO)", raw, re.IGNORECASE)
    detected_line = re.search(r"DETECTED_CATEGORY\s*:\s*(.+)", raw, re.IGNORECASE)
    confidence_line = re.search(r"CONFIDENCE\s*:\s*([0-9]*\.?[0-9]+)", raw, re.IGNORECASE)
    reason_line = re.search(r"REASON\s*:\s*(.+)", raw, re.IGNORECASE)
    is_match = True
    if match_line:
        is_match = match_line.group(1).upper() == "YES"
    elif re.search(r"\bNO\b", raw, re.IGNORECASE):
        is_match = False
    confidence = None
    if confidence_line:
        try:
            confidence = float(confidence_line.group(1))
        except ValueError:
            confidence = None
    return {
        "ok": bool(match_line or detected_line or reason_line),
        "is_match": is_match,
        "detected_category": (detected_line.group(1).strip() if detected_line else ""),
        "confidence": confidence,
        "reason": (reason_line.group(1).strip() if reason_line else ""),
        "raw": raw,
    }


def judge_generated_image_category(payload: Dict, image_item: Dict) -> Dict[str, Any]:
    try:
        project_id, key_file, proxy, _ = parse_common_payload(payload)
        model = (payload.get("judge_model") or "gemini-2.5-flash").strip()
        location = (payload.get("judge_location") or "global").strip()
        main_category = (payload.get("main_category") or "").strip()
        product_name = (payload.get("product_name") or "").strip()
        selling_points = (payload.get("selling_points") or "").strip()
        b64 = str((image_item or {}).get("base64") or "").strip()
        mime_type = str((image_item or {}).get("mime_type") or "image/png").strip()
        if not b64:
            return {"ok": False, "is_match": True, "reason": "empty_image_for_judge", "raw": ""}
        token = get_access_token(key_file, proxy)
        url = (
            "https://aiplatform.googleapis.com/v1/projects/"
            f"{project_id}/locations/{location}/publishers/google/models/{model}:generateContent"
        )
        headers = {
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json; charset=utf-8",
        }
        judge_prompt = (
            "You are a strict ecommerce product category verifier. "
            "Given one generated product image, decide whether its main subject matches the expected category/product. "
            "Output EXACTLY 4 lines in English:\n"
            "MATCH: YES or NO\n"
            "DETECTED_CATEGORY: <short category>\n"
            "CONFIDENCE: <0-1 decimal>\n"
            "REASON: <short reason>\n\n"
            f"Expected category: {main_category}\n"
            f"Expected product name: {product_name}\n"
            f"Expected selling points: {selling_points}\n"
            "Rules:\n"
            "1) Main visible subject must be expected product category.\n"
            "2) If image is portrait/face/human-only while expected is a product, return NO.\n"
            "3) If uncertain, return NO.\n"
            "4) Be conservative."
        )
        body = {
            "contents": [
                {
                    "role": "user",
                    "parts": [{"text": judge_prompt}, {"inlineData": {"mimeType": mime_type, "data": b64}}],
                }
            ]
        }
        resp = requests.post(url, headers=headers, json=body, timeout=70, proxies=build_proxies(proxy))
        data = resp.json() if resp.headers.get("content-type", "").find("json") >= 0 else {"raw": resp.text}
        raw_text = extract_vertex_text(data)
        parsed = parse_category_judge_text(raw_text)
        parsed["status_code"] = resp.status_code
        parsed["model"] = model
        parsed["response_ok"] = resp.ok
        if not resp.ok:
            parsed["ok"] = False
            parsed["is_match"] = True
            parsed["reason"] = parsed.get("reason") or "judge_api_failed_skip_block"
        return parsed
    except Exception as e:
        return {"ok": False, "is_match": True, "reason": f"judge_exception_skip_block: {e}", "raw": ""}


def _is_retryable_litellm_status(resp: Response) -> bool:
    """Shared retryable-status check for both sync and streaming LiteLLM calls."""
    return resp.status_code in {429, 500, 502, 503, 504}


def _build_litellm_body(model: str, messages: List[Dict], temperature, max_tokens, top_p,
                        stream: bool = False, tools: Optional[List[Dict]] = None) -> Dict:
    """Build the LiteLLM request body, skipping unsupported params for gpt-5 family."""
    body: Dict[str, Any] = {"model": model, "messages": messages}
    if stream:
        body["stream"] = True
    is_gpt5_family = "gpt-5" in str(model or "").lower()
    if not is_gpt5_family:
        if temperature is not None:
            body["temperature"] = temperature
        if max_tokens is not None:
            body["max_tokens"] = max_tokens
        if top_p is not None:
            body["top_p"] = top_p
    if tools:
        body["tools"] = tools
        body["tool_choice"] = "auto"
    return body


def extract_tool_calls(response_data: Dict) -> List[Dict]:
    """Extract tool_calls list from a LiteLLM /chat/completions response.

    Returns a list of tool call objects, each with:
        id, type, function.name, function.arguments (JSON string)
    Returns empty list if no tool calls in response.
    """
    choices = response_data.get("choices") or []
    if not choices:
        return []
    message = choices[0].get("message") or {}
    return message.get("tool_calls") or []


def _make_retry_context(proxy: str):
    """Return (proxy_candidates, total_attempt_slots) for retry loops."""
    candidates = build_proxy_candidates(proxy)
    slots = max(1, len(candidates) * 2)  # 2 attempts per route
    return candidates, slots


def call_litellm_chat(
    *,
    api_base: str,
    api_key: str,
    model: str,
    messages: List[Dict],
    proxy: str = "",
    temperature=None,
    max_tokens=None,
    top_p=None,
    tools: Optional[List[Dict]] = None,
) -> Tuple[int, Dict]:
    def _safe_response_body(resp: Response) -> Dict:
        content_type = (resp.headers.get("content-type", "") or "").lower()
        if "json" in content_type:
            try:
                return resp.json()
            except ValueError:
                pass
        return {"raw": resp.text}

    body = _build_litellm_body(model, messages, temperature, max_tokens, top_p, tools=tools)
    proxy_candidates, total_attempt_slots = _make_retry_context(proxy)
    max_attempts_per_route = 2
    total_attempt = 0
    last_exception: Optional[Exception] = None
    last_retryable_status: Optional[int] = None
    for proxy_map in proxy_candidates:
        for _ in range(max_attempts_per_route):
            total_attempt += 1
            try:
                resp = requests.post(
                    f"{api_base}/chat/completions",
                    headers={
                        "Authorization": f"Bearer {api_key}",
                        "Content-Type": "application/json",
                        # Avoid stale keep-alive sockets that can trigger intermittent EOF in TLS.
                        "Connection": "close",
                    },
                    json=body,
                    timeout=(10, 90),
                    proxies=proxy_map,
                )
                if _is_retryable_litellm_status(resp):
                    last_retryable_status = resp.status_code
                    if total_attempt < total_attempt_slots:
                        time.sleep(0.8 * (2 ** min(total_attempt - 1, 4)) * (0.5 + random.random() * 0.5))
                        continue
                data = _safe_response_body(resp)
                return resp.status_code, {"ok": resp.ok, "status_code": resp.status_code, "response": data}
            except (requests.exceptions.SSLError, requests.exceptions.ConnectionError, requests.exceptions.Timeout) as e:
                last_exception = e
                if total_attempt < total_attempt_slots:
                    time.sleep(0.8 * (2 ** min(total_attempt - 1, 4)) * (0.5 + random.random() * 0.5))
                    continue

    if last_exception is not None:
        raise RuntimeError(
            f"LiteLLM chat transient failure after {total_attempt} attempts: {last_exception}"
        ) from last_exception
    raise RuntimeError(
        f"LiteLLM chat transient failure after {total_attempt} attempts: retryable status={last_retryable_status}"
    )


def call_litellm_chat_stream(
    *,
    api_base: str,
    api_key: str,
    model: str,
    messages: List[Dict],
    proxy: str = "",
    temperature=None,
    max_tokens=None,
    top_p=None,
) -> Iterator[Dict[str, Any]]:
    def _extract_delta_text(choice: Dict[str, Any]) -> str:
        delta = choice.get("delta", {}) if isinstance(choice, dict) else {}
        content = delta.get("content")
        if isinstance(content, str):
            return content
        if isinstance(content, list):
            out = []
            for item in content:
                if isinstance(item, str):
                    out.append(item)
                elif isinstance(item, dict):
                    txt = item.get("text") or item.get("value") or ""
                    if isinstance(txt, str) and txt:
                        out.append(txt)
            return "".join(out)
        return ""

    body = _build_litellm_body(model, messages, temperature, max_tokens, top_p, stream=True)
    proxy_candidates, total_attempt_slots = _make_retry_context(proxy)
    max_attempts_per_route = 2
    total_attempt = 0
    last_exception: Optional[Exception] = None
    last_retryable_status: Optional[int] = None

    for proxy_map in proxy_candidates:
        for _ in range(max_attempts_per_route):
            total_attempt += 1
            try:
                with requests.post(
                    f"{api_base}/chat/completions",
                    headers={
                        "Authorization": f"Bearer {api_key}",
                        "Content-Type": "application/json",
                        "Connection": "close",
                    },
                    json=body,
                    timeout=(10, 120),
                    proxies=proxy_map,
                    stream=True,
                ) as resp:
                    if _is_retryable_litellm_status(resp):
                        last_retryable_status = resp.status_code
                        if total_attempt < total_attempt_slots:
                            time.sleep(0.8 * (2 ** min(total_attempt - 1, 4)) * (0.5 + random.random() * 0.5))
                            continue
                    if not resp.ok:
                        content_type = (resp.headers.get("content-type", "") or "").lower()
                        if "json" in content_type:
                            try:
                                err_data = resp.json()
                            except ValueError:
                                err_data = {"raw": resp.text}
                        else:
                            err_data = {"raw": resp.text}
                        raise RuntimeError(
                            f"LiteLLM stream failed status={resp.status_code}: {str(err_data)[:500]}"
                        )

                    full_chunks: List[str] = []
                    for line in resp.iter_lines(decode_unicode=True):
                        txt = str(line or "").strip()
                        if not txt or not txt.startswith("data:"):
                            continue
                        payload = txt[5:].strip()
                        if not payload:
                            continue
                        if payload == "[DONE]":
                            break
                        try:
                            chunk = json.loads(payload)
                        except Exception:
                            continue
                        choices = chunk.get("choices") if isinstance(chunk, dict) else None
                        if not isinstance(choices, list) or not choices:
                            continue
                        choice0 = choices[0] if isinstance(choices[0], dict) else {}
                        delta_text = _extract_delta_text(choice0)
                        if delta_text:
                            full_chunks.append(delta_text)
                            yield {"type": "delta", "delta": delta_text}

                    yield {
                        "type": "done",
                        "content": "".join(full_chunks),
                        "ok": True,
                        "status_code": resp.status_code,
                    }
                    return
            except (requests.exceptions.SSLError, requests.exceptions.ConnectionError, requests.exceptions.Timeout) as e:
                last_exception = e
                if total_attempt < total_attempt_slots:
                    time.sleep(0.8 * (2 ** min(total_attempt - 1, 4)) * (0.5 + random.random() * 0.5))
                    continue

    if last_exception is not None:
        raise RuntimeError(
            f"LiteLLM chat transient stream failure after {total_attempt} attempts: {last_exception}"
        ) from last_exception
    raise RuntimeError(
        f"LiteLLM chat transient stream failure after {total_attempt} attempts: retryable status={last_retryable_status}"
    )


def extract_gs_paths(obj) -> List[str]:
    found = set()

    def walk(node):
        if node is None:
            return
        if isinstance(node, str):
            for m in re.findall(r"gs:\/\/[^\s\"'<>]+", node):
                found.add(m)
            return
        if isinstance(node, list):
            for i in node:
                walk(i)
            return
        if isinstance(node, dict):
            for v in node.values():
                walk(v)

    walk(obj)
    return sorted(found)


def extract_inline_videos(obj) -> List[Dict[str, str]]:
    videos = []

    def walk(node):
        if isinstance(node, dict):
            b64 = node.get("bytesBase64Encoded")
            mime = node.get("mimeType", "video/mp4")
            if isinstance(b64, str) and b64 and str(mime).startswith("video/"):
                videos.append({"mime_type": str(mime), "base64": b64, "data_url": f"data:{mime};base64,{b64}"})
            for v in node.values():
                walk(v)
        elif isinstance(node, list):
            for i in node:
                walk(i)

    walk(obj)
    return videos


@lru_cache(maxsize=4)
def _get_gcs_client(key_file: str) -> storage.Client:
    """Cache GCS Storage Client per key_file (avoids re-reading JSON on every sign call)."""
    creds = service_account.Credentials.from_service_account_file(key_file)
    return storage.Client(project=creds.project_id, credentials=creds)


# Signed URL cache: {(gs_uri, key_file, expires_seconds): (signed_url, created_at)}
# Entries are reused until (expires_seconds - 120)s to avoid returning near-expired URLs.
_sign_url_cache: dict = {}

def sign_gcs_url(gs_uri: str, key_file: str, expires_seconds: int = 3600) -> str:
    m = re.match(r"^gs:\/\/([^\/]+)\/(.+)$", gs_uri)
    if not m:
        return ""
    cache_key = (gs_uri, key_file, expires_seconds)
    now = time.time()
    cached = _sign_url_cache.get(cache_key)
    if cached:
        signed_url, created_at = cached
        if now - created_at < expires_seconds - 120:  # 2-minute safety margin
            return signed_url
    bucket_name, blob_name = m.group(1), m.group(2)
    client = _get_gcs_client(key_file)
    blob = client.bucket(bucket_name).blob(blob_name)
    signed_url = blob.generate_signed_url(version="v4", expiration=expires_seconds, method="GET")
    _sign_url_cache[cache_key] = (signed_url, now)
    return signed_url


def run_google_image_generate(payload: Dict) -> Tuple[int, Dict]:
    project_id, key_file, proxy, model = parse_common_payload(payload)
    prompt = (payload.get("prompt") or "").strip()
    location = (payload.get("location") or "us-central1").strip()
    sample_count = int(payload.get("sample_count", 1))
    aspect_ratio = (payload.get("aspect_ratio") or "16:9").strip()
    person_generation = (payload.get("person_generation") or "allow_adult").strip()
    if not model:
        model = "imagen-3.0-generate-002"
    if not prompt:
        raise ValueError("google image prompt 不能为空")
    token = get_access_token(key_file, proxy)
    url = (
        "https://aiplatform.googleapis.com/v1/projects/"
        f"{project_id}/locations/{location}/publishers/google/models/{model}:predict"
    )
    headers = {"Authorization": f"Bearer {token}", "Content-Type": "application/json; charset=utf-8"}
    body = {
        "instances": [{"prompt": prompt}],
        "parameters": {
            "sampleCount": sample_count,
            "aspectRatio": aspect_ratio,
            "personGeneration": person_generation,
            "addWatermark": False,
        },
    }
    resp = requests.post(url, headers=headers, json=body, timeout=90, proxies=build_proxies(proxy))
    data = resp.json() if resp.headers.get("content-type", "").find("json") >= 0 else {"raw": resp.text}
    images = extract_imagen_images(data)
    return resp.status_code, {
        "ok": resp.ok,
        "status_code": resp.status_code,
        "model": model,
        "response": data,
        "images": images,
    }


def infer_target_race(selling_region: str) -> str:
    region = (selling_region or "").lower()
    if any(k in region for k in ["japan", "korea", "china", "hong kong", "taiwan", "新加坡", "日本", "韩国", "中国"]):
        return "East Asian"
    if any(k in region for k in ["saudi", "uae", "dubai", "qatar", "kuwait", "阿联酋", "沙特", "中东"]):
        return "Arab"
    if any(k in region for k in ["us", "usa", "united states", "canada", "uk", "europe", "欧美", "欧洲"]):
        return "Caucasian"
    if any(k in region for k in ["thailand", "vietnam", "indonesia", "malaysia", "菲律宾", "东南亚"]):
        return "Southeast Asian"
    if any(k in region for k in ["africa", "nigeria", "kenya", "south africa", "非洲"]):
        return "African"
    return "Local market appropriate ethnicity"


def build_shoplive_image_rule_capsule(payload: Dict, use_model: bool, is_contact_lens: bool) -> str:
    product_name = (payload.get("product_name") or "").strip() or "generic product"
    main_category = (payload.get("main_category") or "").strip() or "ecommerce product"
    target_audience = (payload.get("target_audience") or "").strip() or "general online shoppers"
    brand_philosophy = (payload.get("brand_philosophy") or "").strip() or "clean and premium"
    selling_region = (payload.get("selling_region") or "").strip() or "global market"
    selling_points = (payload.get("selling_points") or "").strip() or "clear product benefits"
    other_info = (payload.get("other_info") or "").strip() or "none"
    language_code = (payload.get("language_code") or "zh-CN").strip()
    currency_code = (payload.get("currency_code") or "CNY").strip()
    exchange_rate = str(payload.get("exchange_rate") or "7.20").strip()
    product_count = int(payload.get("product_count") or payload.get("sample_count") or 1)
    product_count = max(1, min(product_count, 4))
    target_race = infer_target_race(selling_region)
    base_context = (
        f"Context -> category: {main_category}; product: {product_name}; target audience: {target_audience}; "
        f"target race inferred from market: {target_race}; brand philosophy: {brand_philosophy}; "
        f"market: {selling_region}; language: {language_code}; currency: {currency_code}; "
        f"usd exchange rate: {exchange_rate}; key selling points: {selling_points}; other info: {other_info}. "
    )
    planning_rules = (
        f"Internal planning rules: reason over {product_count} possible variants of the SAME category, "
        "consider style/material/color/detail diversity, and choose one strongest visual variant for this final image. "
        "Keep category consistency as highest priority. "
        "You may internally reason with title/description/price logic, but DO NOT render any text, numbers, logo, "
        "watermark, certification mark, QR code, URL, or brand name in the image."
    )
    composition_rules = (
        "Visual rules: centered subject; balanced safe margins; complete structure; realistic proportions; "
        "50mm product photography language; no collage; no studio rigs."
    )
    if is_contact_lens:
        scene_rules = (
            "Template lock (contact lens): right-eye-only macro composition, 100mm macro style, "
            "full right eyebrow and lower eyelid visible, sharp iris/lens texture, clean high-end seamless background."
        )
    elif use_model:
        scene_rules = (
            "Template lock (model apparel): single full-body model only, realistic anatomy, full head-to-toe visible, "
            "off-white seamless background, 5%-8% headroom and >=3% footroom."
        )
    else:
        scene_rules = (
            "Template lock (product-only): single complete saleable unit only, no human body parts, "
            "pure white seamless background, centered composition, product area <= 50% frame."
        )
    category_specific_rules = (
        "Category-specific layout: shoes -> symmetric front placement; bags -> straight front upright; "
        "socks -> flat lay only; watches -> centered dial with natural strap curve; "
        "phone/tablet -> two identical devices side-by-side (left back, right front, slight overlap, no foldable); "
        "bike/scooter/balance vehicle -> right-facing strict side profile, wheels aligned."
    )
    return " ".join([base_context, planning_rules, composition_rules, scene_rules, category_specific_rules]).strip()


def build_shoplive_image_prompt(payload: Dict) -> str:
    product_name = (payload.get("product_name") or "").strip() or "Generic product"
    main_category = (payload.get("main_category") or "").strip() or "Ecommerce product"
    target_audience = (payload.get("target_audience") or "").strip() or "general online shoppers"
    brand_philosophy = (payload.get("brand_philosophy") or "").strip() or "clean and conversion-oriented"
    selling_region = (payload.get("selling_region") or "").strip() or "global market"
    selling_points = (payload.get("selling_points") or "").strip() or "core value proposition"
    other_info = (payload.get("other_info") or "").strip()
    language_code = (payload.get("language_code") or "zh-CN").strip()
    currency_code = (payload.get("currency_code") or "CNY").strip()
    exchange_rate = str(payload.get("exchange_rate") or "7.20").strip()
    product_count = int(payload.get("product_count") or payload.get("sample_count") or 2)
    product_count = max(1, min(product_count, 4))
    target_race = infer_target_race(selling_region)
    return f"""
角色定义
你是一个专业的AI图像生成提示词工程师，非常擅长生成商品图片的生成提示词。
[图片]
任务目标
根据输入的 售卖地区/目标市场，推理出目标人种，然后再根据 商品名称、售卖地区、商品卖点、目标人种、商品风格模版、其他信息 等上下文信息，为指定的主营品类生成商品图片的生成提示词。

输入
 商品名称、售卖地区、商品卖点、目标人种、商品风格模版、其他信息 等上下文信息

当前输入上下文
- 商品名称: {product_name}
- 主营品类: {main_category}
- 售卖地区: {selling_region}
- 商品卖点: {selling_points}
- 目标人种: {target_race}
- 商品风格模版: {brand_philosophy}
- 其他信息: {other_info}
- 目标语言: {language_code}
- 目标货币: {currency_code}
- 汇率: {exchange_rate}
- 候选数量: {product_count}

Content (生图提示词):
生成Content的核心推理逻辑：思维链：
1. 分析输入：分析输入数据（商品名称、售卖地区、商品卖点、目标人种、商品风格模版、其他信息 等上下文信息），来生成Content，忽略其他与商品展示无关内容。
2. 确定拍摄场景（有模特 / 无模特）：你必须自行推断是否需要模特场景。
  - 决策目标：优先选择最能体现该商品核心卖点的拍摄场景。
  - 默认策略：
    - 优先选择“有模特场景”：当商品属于服装类且卖点依赖穿着效果与身形比例（如：连衣裙、外套、上衣、裤装、套装、内衣/泳装等）。
    - 优先选择“无模特场景”：当商品更适合以单品静物展示（如：箱包、小家电、厨具、家居用品、数码产品、美妆、文具、袜子、腕表等）。
3. 校验视觉规范:
1）构图方式: 在无缝背景本身上预留安全边距（safe margin）：左右留白均等，头顶与脚部留有充足空间（这是背景留白，不是画框/相框/边框效果）。
2）主体完整性: 确保单一主体、真实比例、头部完整、着装、结构完整。
3）空间占比: 严格控制50mm 焦段拍摄，强制模特全身构图，确保模特从头顶到脚尖完全收录于画面内，
4）品类特定参数: 应用鞋类（对称摆放）等专业参数。
4. 核对规则: 检查所有规则，包括 通用基础规则、品类特定规则，必须遵循规则来生成Content。 
5. 构建提示词: 请根据你在第2步推断的“有模特/无模特”场景，选择并严格套用对应模板（模板1或模板2或模版3），仅替换 [SCENE、WARDROBE、SUBJECT] 部分；其他部分不能随意修改和省略；不得混用三套模板的关键约束。若信息不足以判断，优先采用“无模特场景”以降低出错率。
模板 1（有模特 / 服装）
SCENE:
A model whose ethnicity, age, and gender match the product's target market. The model's body proportions are realistic, their pose is natural, and their head is clear and fully visible.

WARDROBE:
Describe the wearable item(s) based on the product title, focusing on type, color, and fit suitable for a full-body view. Do not describe microscopic details (e.g., stitching, fabric texture) or use phrases like 'as the main item'.
If the product is an underwear/lingerie/swimwear category (e.g., bra, panties/briefs/boxers, lingerie set, bodysuit, swimsuit), it is allowed to show only that item (or a matching set) without adding an extra top+bottom outfit. For non-underwear apparel, show a complete outfit (top + bottom).

ENVIRONMENT:
Seamless off-white background.

LIGHTING:
Standard product still-life photography lighting setup.

CAMERA:
Use a 50mm focal length to shoot a vertical full-body shot.

COMPOSITION
Vertical full-body shot on a seamless off-white background. Maintain strict safe margins between the model and the image borders, ensuring 5%-8% headroom above the head and at least 3% footroom below the feet. The model is perfectly centered, with the continuous off-white background extending to all four edges without obstruction.

STYLE:
Product still-life photography style.

OUTPUT:
2K resolution, sharp and clear.


---

模板 2（无模特）

SUBJECT:
The frame contains only a single, independent, complete saleable unit of the product. First, identify the product category/type from the title and description. Then, present it in a professional arrangement suitable for that category (e.g., facing forward, upright). The product must have a generic, unbranded appearance; Ensure the complete saleable unit is shown in full.

ENVIRONMENT:
Seamless pure white background.

LIGHTING:
Standard product still-life photography lighting setup.

CAMERA:
Use a 50mm focal length to shoot a vertical product shot. Camera position approximately 2.8m from the product.


COMPOSITION
The product is presented completely and centered, with ample and balanced negative space on all sides, and does not occupy more than 50% of the image.

STYLE:
Product still-life photography style.

OUTPUT:
2K resolution, sharp and clear.

OTHER REQUIREMENT:
The product must have a generic, unbranded appearance, strictly forbid any brand logos, trademarks, or watermarks, brand names on its surface.


---

模板 3（美瞳/隐形眼镜）

SUBJECT:
The frame contains a close-up shot strictly of the right eye, focusing on the intricate iris texture and the wearing effect of the contact lenses (the product). The model's eye area—skin tone, eyelashes, eye shape—should be natural and realistic, aligning with the aesthetic preferences of the target market.

ENVIRONMENT:
A seamless, soft, uniform high-end makeup/product photography studio background, free from any environmental shadows or distractions.

LIGHTING:
Standard product still-life photography lighting. Soft, even illumination designed to emphasize the natural texture of the periocular skin and the hydrated, glossy finish of the product (contact lenses/circle lenses).

CAMERA:
Use a professional 100mm Macro Lens for ultra-sharp macro photography.

FOCUS & DETAIL
Ensure razor-sharp focus is locked onto the surface of the eyeball. The texture and edges of the cosmetic contact lens, the intricate structure of the iris, tiny blood vessels in the whites of the eye (sclera), and details of the surrounding skin pores must all be rendered with absolute clarity.

COMPOSITION
The shot must be absolutely centered on the right eye only. The frame above must fully include the entire right eyebrow, showing the natural flow of hair strands and the brow bone structure. The frame below must include the complete right lower eyelid, lower lashes, and the skin of the partial right under-eye triangle area.

STYLE:
Product still-life photography style.

OUTPUT:
2K resolution, The image quality is sharp and clear.

通用基础原则：
1. 构图定式（最高优先级）:
1）留白: 必须明确描述“主体位于画面正中心，头顶与脚底留有充足空间，左右两侧留白均等”。
2）画面占比: 无模特: 完整商品最多占画面的 50%。
2. 主体完整性与比例:
  - 有模特场景:
  1）数量与比例: 仅限单一模特。必须呈现真实的物理人体比例，头部完整可见。
  2）着装规范: 默认模特穿着完整套装（上装+下装），但内衣/内裤/泳装等贴身品类允许仅展示该贴身单品或同系列成套（无需额外外搭上装+下装）。在任何情况下画面需电商合规、干净克制、无不当裸露的强调。
  3）属性匹配: 根据 {main_category} 和 {target_audience} 确定性别年龄；根据{selling_region} 严格推理并锁定目标人种（如：日本→东亚人种；沙特→阿拉伯人）。
  - 无模特场景: 仅展示商品主体，严禁出现人体部位（手/脚/脸/颈部等），保证“单个可售单位”完整且可识别。
  2）呈现方式: 必须是专业化摆放的商品完整拍摄图，严禁拼接图。
  3）去商业化: 严禁在产品表面出现任何品牌 Logo、商标、水印或序列号，确保产品外观是通用的、无特定品牌特征的。
3. 摄影风格与画质控制: 统一使用“单品静物摄影”作为风格基调。技术参数: 必须包含 2k 分辨率、高细节、清晰对焦。严禁元素: 严禁出现品牌标志、logo、吊牌、文字、商业元素、水印、杂物、主题化背景或夸张布置。严禁露出摄影棚灯架、支架等任何非自然环境标志物。
4. 背景与光影规范:
  - 有模特场景: 采用无缝米白色背景，无任何其他与物体无关干扰元素。
  - 无模特场景: 采用无缝纯白色背景，无任何其他与物体无关干扰元素。
品类特定规则
- 有模特场景 (服装品类):
  - 主体: 单一模特，具有 真实的人体比例。
  - 镜头语言：使用全身镜头，从头到脚完整覆盖。
  - 质感呈现: 降权微观细节描述，强调整体质感
  - 结构纠正: 明确正常人体比例。
- 无模特场景 (服装以外的品类，例如：首饰、戒指、包袋、小家电、鞋类等):
  - 主体: 产品本身，经过专业化的摆放。
  - 品类特定规则:
   1）鞋类: 鞋类商品应采用正面朝前、左右对称、平行微展的标准摆放姿态，以完整且对称地呈现鞋头轮廓、鞋面材质、鞋带系法及扣件。
   2）箱包: 箱包类商品应保持正前方直视视角，并确保包身自然直立、形态饱满，以完整展示包身的宽度比例与正面设计特征。
   3）袜子： 袜子类商品主图应采用平铺拍摄的方式，将与销售单位对应的袜子完整平整地放置在纯白背景上，自然舒展无褶皱，不得出现模特、人体模型、文字、水印或非售卖道具。
   4）腕表类： 采用正前方直视视角，确保表盘绝对居中且占据画面核心。表带须从表耳处自然向下延伸，呈现符合重力逻辑的流畅弧度（即模拟佩戴后的自然垂坠感），严禁采用截断式构图或僵硬的平铺摆放。光影需精准勾勒表圈边缘与指针质感，配合纯色背景，确保整体视觉呈现出如名表画册般的极简、高端且严谨的单品特写效果。
   5）手机/平板类: 必须明确描述为“两部相同的设备并排站立”（Two identical devices standing side-by-side）。左侧设备展示背面（Back view），右侧设备展示正面亮屏（Front view）。两者紧密相邻，右侧设备的左边缘轻微遮挡左侧设备的右边缘（Slight overlap）。严禁出现折叠屏形态（No foldable, no flip, no hinge），严禁堆叠。保持绝对正平视视角，确保轮廓为标准矩形且无品牌Logo。
   6）平衡车/自行车/电动滑板车类: 采用正侧面（Side profile view）拍摄，车头朝右，车身保持水平直立。确保前后轮完全可见且处于同一水平线上，背景纯白无杂物。构图居中，车辆占据画面中心位置，四周留有适度空白。严禁出现倾斜、俯视或透视变形。

最终输出指令：
请根据以上所有要求，仅输出一个可直接用于图像生成模型的英文提示词（Content），不要输出 JSON，不要解释，不要附加其他说明。画面比例固定为 3:4。
""".strip()


def build_shoplive_image_prompt_compact(payload: Dict) -> str:
    product_name = (payload.get("product_name") or "").strip() or "generic product"
    main_category = (payload.get("main_category") or "").strip() or "ecommerce product"
    target_audience = (payload.get("target_audience") or "").strip() or "general online shoppers"
    brand_philosophy = (payload.get("brand_philosophy") or "").strip() or "clean and premium"
    selling_region = (payload.get("selling_region") or "").strip() or "global market"
    selling_points = (payload.get("selling_points") or "").strip() or "clear product benefits"
    target_race = infer_target_race(selling_region)
    category_l = main_category.lower()
    apparel_keywords = ["dress", "shirt", "top", "pants", "skirt", "coat", "jacket", "连衣裙", "上衣", "裤", "外套", "裙"]
    use_model = any(k in category_l for k in apparel_keywords)
    dress_keywords = ["dress", "gown", "连衣裙", "裙"]
    is_dress = any(k in category_l or k in product_name.lower() for k in dress_keywords)
    contact_lens_keywords = ["contact lens", "contacts", "circle lens", "美瞳", "隐形眼镜"]
    is_contact_lens = any(k in category_l or k in product_name.lower() for k in contact_lens_keywords)
    rule_capsule = build_shoplive_image_rule_capsule(payload, use_model=use_model, is_contact_lens=is_contact_lens)
    if use_model:
        subject_block = (
            f"One full-body model ({target_race}) suitable for {target_audience}, realistic body proportions, natural pose, full head-to-toe visible."
        )
        env_block = "Seamless off-white studio background."
        composition = "Vertical 3:4 full-body composition, centered subject, 5%-8% headroom and at least 3% footroom."
    else:
        if is_dress:
            subject_block = (
                "Single complete full-length dress garment only, from neckline to hem fully visible, "
                "displayed on a hanger or invisible mannequin, centered, generic unbranded appearance."
            )
        else:
            subject_block = f"Single complete saleable unit of {main_category}, professionally arranged, centered, generic unbranded appearance."
        env_block = "Seamless pure white studio background."
        composition = "Vertical 3:4 composition, centered product, balanced negative space, product occupies <= 50% frame."
    return (
        "Commercial ecommerce product still-life photo. "
        f"Product name: {product_name}. Category: {main_category}. Selling points: {selling_points}. "
        f"Target market: {selling_region}. Brand philosophy: {brand_philosophy}. "
        f"{rule_capsule} "
        f"{subject_block} {env_block} "
        "Lighting: standard product still-life studio lighting. "
        "Camera: 50mm focal length. "
        f"{composition} "
        f"The generated subject MUST strictly match this category and product name: {main_category} / {product_name}. "
        "Do not generate any unrelated product category. "
        "No portrait close-up, no headshot, no only-face composition. "
        "2K resolution, sharp focus, clear texture. "
        "No logos, no trademarks, no watermarks, no text overlays, no clutter, no collage."
    ).strip()


def build_shoplive_image_prompt_safe_product_only(payload: Dict) -> str:
    product_name = (payload.get("product_name") or "").strip() or "generic product"
    main_category = (payload.get("main_category") or "").strip() or "ecommerce product"
    selling_points = (payload.get("selling_points") or "").strip() or "clear product benefits"
    selling_region = (payload.get("selling_region") or "").strip() or "global market"
    category_l = main_category.lower()
    dress_keywords = ["dress", "gown", "连衣裙", "裙"]
    is_dress = any(k in category_l or k in product_name.lower() for k in dress_keywords)
    contact_lens_keywords = ["contact lens", "contacts", "circle lens", "美瞳", "隐形眼镜"]
    is_contact_lens = any(k in category_l or k in product_name.lower() for k in contact_lens_keywords)
    rule_capsule = build_shoplive_image_rule_capsule(payload, use_model=False, is_contact_lens=is_contact_lens)
    if is_dress:
        subject = (
            "Single complete full-length dress garment only, from neckline to hem fully visible, "
            "displayed on a hanger or invisible mannequin, centered."
        )
    else:
        subject = "Single complete saleable product unit only, centered."
    return (
        "Ecommerce product-only still-life photo. "
        f"Product name: {product_name}. Category: {main_category}. Selling points: {selling_points}. "
        f"Target market: {selling_region}. "
        f"{rule_capsule} "
        "No people, no human body parts, no faces, no model, no hands. "
        f"{subject} "
        "Strictly prohibit any unrelated category item. "
        "No portrait close-up, no headshot, no only-face composition. "
        "Unbranded appearance. "
        "Seamless pure white background. "
        "Standard product still-life studio lighting. "
        "50mm focal length. Vertical 3:4 composition with balanced negative space. "
        "2K resolution, sharp focus, clear texture. "
        "No logos, no trademarks, no watermarks, no text overlays, no clutter, no collage."
    ).strip()


# ---------------------------------------------------------------------------
# LLM-driven image prompt builder (PRODUCT_EXPANSION Content template)
# ---------------------------------------------------------------------------

_IMAGE_PROMPT_LLM_SYSTEM = """
You are a professional AI image generation prompt engineer specialised in ecommerce product photography.

Given product context, you must output a single, self-contained Imagen/Stable Diffusion prompt that follows the rules below.

STEP 1 — SCENE SELECTION (pick exactly one):
- Template A (With Model / Apparel): use when main_category is clothing, dress, top, pants, skirt, coat, jacket, swimwear, underwear, or any wearable garment.
- Template B (Product Only): use for accessories, bags, footwear, socks, eyewear, jewelry, belts, hats, small appliances, phones, watches, etc.
- Template C (Contact Lens): use only when product is contact lenses / circle lenses / 美瞳.

STEP 2 — TARGET RACE: infer from selling_region.
  Japan/Korea/China/Taiwan/HK/SG → East Asian
  Saudi/UAE/Qatar/Kuwait/Middle East → Arab
  US/Canada/UK/Europe → Caucasian
  Thailand/Vietnam/Indonesia/Malaysia/Philippines → Southeast Asian
  Africa → African
  Otherwise → ethnicity appropriate for the target market

STEP 3 — BUILD PROMPT using the matching template below. Replace only [BRACKETED] parts.

--- Template A (With Model) ---
A [TARGET_RACE] [GENDER] model suitable for [TARGET_AUDIENCE]. Realistic body proportions, natural relaxed pose. The model is wearing [DESCRIBE OUTFIT: type, color, fit — do NOT describe microscopic stitching details]. Full-body shot, head to toe fully visible, no cropping. Seamless off-white studio background. Standard ecommerce still-life lighting. 50mm focal length vertical full-body composition. Head at 5% from top, feet at 5% from bottom. No logos, no watermarks, no text. 2K resolution, sharp and clear.

--- Template B (Product Only) ---
Single complete saleable unit of [PRODUCT_TYPE], [PROFESSIONAL_ARRANGEMENT_NOTE: e.g. facing forward / upright / flat lay depending on category]. Centered in frame, product occupies ≤50% of image. Seamless pure white studio background. Standard product still-life lighting. 50mm focal length, vertical composition, balanced negative space. No human body parts, no model, no hands. No logos, no watermarks, no text. Generic unbranded appearance. 2K resolution, sharp and clear.
Category-specific rules: shoes→symmetric front parallel placement; bags→straight front upright natural shape; socks→flat lay only; watches→centered dial, natural strap drape; phone/tablet→two identical devices side by side (left=back view, right=front with screen on, slight overlap, NO foldable form).

--- Template C (Contact Lens) ---
Close-up macro shot of right eye only. Full right eyebrow and lower eyelid visible. Sharp focus on iris texture and contact lens surface. Natural realistic skin and lashes matching target market aesthetics. Seamless soft studio background. Standard macro lighting, soft even illumination. Professional 100mm macro lens. Centered on right eye. 2K resolution, sharp and clear.

STRICT OUTPUT RULES:
- Output ONLY the final image prompt text. No JSON, no explanation, no title, no markdown.
- The prompt must be in English regardless of input language.
- Do NOT include brand names, model numbers, or specific logos in the prompt.
- The generated image must match the exact product category. Do not hallucinate unrelated categories.
""".strip()


def build_image_prompt_via_llm(
    payload: Dict,
    *,
    api_base: str,
    api_key: str,
    model: str = "bedrock-claude-4-5-haiku",
    proxy: str = "",
) -> str:
    """Use an LLM to generate a high-quality image generation prompt following the
    PRODUCT_EXPANSION_SYSTEM_PROMPT Content template logic."""
    product_name    = (payload.get("product_name") or "").strip() or "generic product"
    main_category   = (payload.get("main_category") or "").strip() or "ecommerce product"
    target_audience = (payload.get("target_audience") or "").strip() or "general online shoppers"
    brand_philosophy = (payload.get("brand_philosophy") or "").strip() or "clean and premium"
    selling_region  = (payload.get("selling_region") or "").strip() or "global market"
    selling_points  = (payload.get("selling_points") or "").strip() or "clear product benefits"
    other_info      = (payload.get("other_info") or "").strip() or ""

    user_message = (
        f"Product context:\n"
        f"- product_name: {product_name}\n"
        f"- main_category: {main_category}\n"
        f"- target_audience: {target_audience}\n"
        f"- brand_philosophy: {brand_philosophy}\n"
        f"- selling_region: {selling_region}\n"
        f"- selling_points: {selling_points}\n"
        f"- other_info: {other_info}\n\n"
        "Generate the image prompt now."
    )
    messages = [
        {"role": "system", "content": _IMAGE_PROMPT_LLM_SYSTEM},
        {"role": "user",   "content": user_message},
    ]
    status_code, data_wrap = call_litellm_chat(
        api_base=api_base,
        api_key=api_key,
        model=model,
        messages=messages,
        proxy=proxy,
        temperature=0.4,
        max_tokens=800,
    )
    if not data_wrap.get("ok"):
        raise RuntimeError(f"Image prompt LLM call failed (status={status_code})")
    content = extract_chat_content(data_wrap.get("response", {})).strip()
    if not content:
        raise ValueError("LLM returned empty image prompt")
    return content



def normalize_timeline_video_segments(
    tracks: List[Dict[str, Any]],
    duration_seconds: float,
    *,
    min_seconds: float = 0.05,
    max_segments: int = 80,
    sort_strategy: str = "track_then_start",
) -> List[Dict[str, float]]:
    if duration_seconds <= 0:
        raise ValueError("duration_seconds must be > 0")
    normalized: List[Dict[str, float]] = []
    for track_index, t in enumerate(tracks or []):
        if not isinstance(t, dict):
            continue
        if not bool(t.get("enabled", True)):
            continue
        track_type = str(t.get("track_type") or "").strip().lower()
        label = str(t.get("label") or "").strip().lower()
        if track_type and track_type != "video":
            continue
        if not track_type and label and "video" not in label:
            continue
        segments = t.get("segments") or []
        if not isinstance(segments, list):
            continue
        for seg in segments:
            if not isinstance(seg, dict):
                continue
            start_seconds = seg.get("start_seconds")
            end_seconds = seg.get("end_seconds")
            if start_seconds is not None or end_seconds is not None:
                start = float(start_seconds or 0.0)
                end = float(end_seconds if end_seconds is not None else duration_seconds)
            else:
                left = float(seg.get("left", 0.0))
                width = float(seg.get("width", 0.0))
                start = duration_seconds * max(0.0, min(100.0, left)) / 100.0
                end = duration_seconds * max(0.0, min(100.0, left + width)) / 100.0
            start = max(0.0, min(duration_seconds, start))
            end = max(0.0, min(duration_seconds, end))
            if end - start < min_seconds:
                continue
            normalized.append({
                "start": start,
                "end": end,
                "track_index": float(track_index),
                "track_order": float(t.get("order", 0)),
                "source_index": int(max(0, seg.get("source_index", 0))),
            })
    if sort_strategy == "start_then_track":
        normalized.sort(key=lambda x: (x["start"], x["track_order"], x["track_index"], x["end"]))
    else:
        normalized.sort(key=lambda x: (x["track_order"], x["track_index"], x["start"], x["end"]))
    if len(normalized) > max_segments:
        raise ValueError(f"Too many timeline segments: {len(normalized)} > {max_segments}")
    return normalized


def _ffprobe_has_audio_stream(path: Path) -> bool:
    try:
        r = subprocess.run(
            [
                "ffprobe", "-v", "error",
                "-select_streams", "a:0",
                "-show_entries", "stream=codec_type",
                "-of", "csv=p=0",
                str(path),
            ],
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            text=True,
            timeout=20,
        )
        return bool((r.stdout or "").strip())
    except (FileNotFoundError, subprocess.TimeoutExpired, OSError):
        return False


def mitigate_veo_temporal_flicker(
    input_path: Path,
    output_path: Path,
    *,
    timeout_seconds: int = 420,
) -> Path:
    """Reduce visible luminance pops (often around ~2–4s) in Veo/Grok MP4 output.

    Uses mild hqdn3d (spatial–temporal denoise) plus a short fade-in from black at t=0.
    Set SHOPLIVE_VEO_SKIP_FLICKER_FILTER=1 to copy input → output without re-encode.
    """
    if not input_path.exists():
        raise FileNotFoundError(str(input_path))
    if os.getenv("SHOPLIVE_VEO_SKIP_FLICKER_FILTER", "").strip().lower() in ("1", "true", "yes", "on"):
        shutil.copyfile(input_path, output_path)
        return output_path

    # hqdn3d=luma_spatial:luma_tmp:chroma_spatial:chroma_tmp — keep mild to avoid mushy detail
    vf = "hqdn3d=4:3:6:4.5,fade=t=in:st=0:d=0.22"
    cmd: List[str] = [
        "ffmpeg", "-y",
        "-i", str(input_path),
        "-vf", vf,
        "-c:v", "libx264",
        "-preset", "fast",
        "-crf", "20",
        "-movflags", "+faststart",
    ]
    if _ffprobe_has_audio_stream(input_path):
        cmd.extend(["-c:a", "copy"])
    else:
        cmd.append("-an")
    cmd.append(str(output_path))

    proc = subprocess.run(
        cmd,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        timeout=timeout_seconds,
    )
    if proc.returncode != 0 or not output_path.exists() or output_path.stat().st_size < 1024:
        stderr_tail = (proc.stderr or b"").decode("utf-8", errors="replace")[-600:]
        raise RuntimeError(f"mitigate_veo_temporal_flicker failed (rc={proc.returncode}): {stderr_tail}")
    return output_path


def concat_videos_ffmpeg(video_paths: List[Path], output_path: Path, timeout_seconds: int = 180) -> Path:
    """Concatenate video files using ffmpeg.

    Uses stream-copy when audio streams are compatible (same codec/sample-rate/channels);
    falls back to re-encoding audio to AAC 44100Hz stereo when streams differ or when
    some segments have no audio track.
    """
    if len(video_paths) < 2:
        raise ValueError("concat_videos_ffmpeg requires at least 2 video files")
    for p in video_paths:
        if not p.exists():
            raise FileNotFoundError(f"Video segment not found: {p}")

    # Probe audio streams for all segments.
    # Returns None on probe failure (FileNotFoundError / timeout / non-zero rc) to distinguish
    # from "no audio track" (empty string), enabling conservative fallback behaviour.
    def _probe_audio(path: Path):
        try:
            result = subprocess.run(
                [
                    "ffprobe", "-v", "error",
                    "-select_streams", "a",
                    "-show_entries", "stream=codec_name,sample_rate,channels",
                    "-of", "csv=p=0",
                    str(path),
                ],
                stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
                timeout=15,
            )
            if result.returncode != 0:
                return None  # probe failed — treat conservatively
            return (result.stdout or "").strip()
        except (FileNotFoundError, subprocess.TimeoutExpired, OSError):
            return None  # ffprobe unavailable or timed out

    audio_infos = [_probe_audio(p) for p in video_paths]
    probe_failed = any(a is None for a in audio_infos)

    if probe_failed:
        # Conservative: assume mixed audio, re-encode to safe common params
        has_any_audio = True
        all_same_audio = False
    else:
        has_any_audio = any(bool(a) for a in audio_infos)
        # Use stream copy only when all segments have audio with identical params
        all_same_audio = (
            has_any_audio
            and all(bool(a) for a in audio_infos)
            and len(set(audio_infos)) == 1
        )

    with tempfile.NamedTemporaryFile(mode="w", suffix=".txt", delete=False) as f:
        for vp in video_paths:
            f.write(f"file '{vp.resolve()}'\n")
        list_file = Path(f.name)

    try:
        if all_same_audio:
            # All segments have identical audio: safe to stream-copy everything
            cmd = [
                "ffmpeg", "-y",
                "-f", "concat", "-safe", "0",
                "-i", str(list_file),
                "-c", "copy",
                "-movflags", "+faststart",
                str(output_path),
            ]
        elif has_any_audio:
            # Mixed audio (some segments missing audio or different params):
            # re-encode audio to AAC 44100Hz stereo, copy video stream
            cmd = [
                "ffmpeg", "-y",
                "-f", "concat", "-safe", "0",
                "-i", str(list_file),
                "-c:v", "copy",
                "-c:a", "aac", "-ar", "44100", "-ac", "2", "-b:a", "128k",
                "-movflags", "+faststart",
                str(output_path),
            ]
        else:
            # No audio in any segment: copy video only
            cmd = [
                "ffmpeg", "-y",
                "-f", "concat", "-safe", "0",
                "-i", str(list_file),
                "-c:v", "copy", "-an",
                "-movflags", "+faststart",
                str(output_path),
            ]

        proc = subprocess.run(
            cmd,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            timeout=timeout_seconds,
        )
        if proc.returncode != 0:
            stderr_tail = (proc.stderr or b"").decode("utf-8", errors="replace")[-600:]
            raise RuntimeError(f"ffmpeg concat failed (rc={proc.returncode}): {stderr_tail}")
        if not output_path.exists() or output_path.stat().st_size < 1024:
            raise RuntimeError("ffmpeg concat produced empty or missing output")
        return output_path
    finally:
        try:
            list_file.unlink(missing_ok=True)
        except Exception:
            pass


def download_gcs_blob_to_file(
    gcs_uri: str,
    output_path: Path,
    key_file: str,
    project_id: str = "qy-shoplazza-02",
    _max_attempts: int = 3,
) -> Path:
    m = re.match(r"^gs://([^/]+)/(.+)$", gcs_uri)
    if not m:
        raise ValueError(f"Invalid GCS URI: {gcs_uri}")
    bucket_name, blob_name = m.group(1), m.group(2)
    # Reuse the lru_cache'd client to avoid re-reading the key file on every download
    client = _get_gcs_client(key_file)
    blob = client.bucket(bucket_name).blob(blob_name)
    last_exc: Exception = RuntimeError("download_gcs_blob_to_file: no attempts made")
    for attempt in range(_max_attempts):
        try:
            blob.download_to_filename(str(output_path))
            return output_path
        except Exception as exc:
            last_exc = exc
            if attempt < _max_attempts - 1:
                time.sleep((0.5 + random.random() * 0.5) * (attempt + 1))
    raise last_exc


def _build_prompt_split_system(segment_duration: int, total_duration: int) -> str:
    """Build a prompt-split system message for any N-second video split into 2 equal segments."""
    half = total_duration // 2
    assert half == segment_duration, "segment_duration must equal total_duration // 2"
    shot_interval = max(1, segment_duration // 4)
    timestamps = " ".join(
        f"[00:0{i*shot_interval:02d}-00:0{(i+1)*shot_interval:02d}] shot {i+1} description."
        for i in range(4)
    )
    return (
        f"You are a professional ecommerce video director and prompt architect.\n"
        f"Your task: split ONE product video prompt into exactly TWO {segment_duration}-second segment prompts "
        f"that together form a seamless {total_duration}-second product video.\n\n"

        "═══ STEP 1: EXTRACT VISUAL ANCHORS (do this internally before writing segments) ═══\n"
        "Before splitting, identify and lock these elements from the original prompt:\n"
        "  • PRODUCT: exact product name, color, material, key visual features\n"
        "  • STYLE: cinematic tone, visual style (clean/editorial/lifestyle/etc.)\n"
        "  • LIGHTING: lighting setup (soft natural / studio / golden hour / etc.)\n"
        "  • COLOR PALETTE: dominant colors and mood\n"
        "  • CAMERA LANGUAGE: lens style, movement type (push-in/handheld/static/etc.)\n"
        "These anchors MUST appear consistently in BOTH segments. Never contradict them.\n\n"

        "═══ STEP 2: ASSIGN NARRATIVE ROLES (strictly follow this) ═══\n"
        f"- Part 1 ({segment_duration}s): PRODUCT HERO OPENING — camera pushes in from wide to medium, "
        "revealing the product's form and silhouette. Focus on the most striking visual feature. "
        "Set the mood and color palette for the whole video.\n"
        f"- Part 2 ({segment_duration}s): USAGE / EMOTIONAL PAYOFF — a DIFFERENT camera angle and "
        "environment from Part 1. Show the product being used, demonstrate a key feature up-close, "
        "or show a lifestyle context with emotional connection. Ends with a confident closing shot.\n\n"

        "═══ STEP 3: WRITE EACH SEGMENT PROMPT ═══\n"
        "For each segment:\n"
        "  • BEGIN with the locked visual anchors (product + style + lighting + palette)\n"
        "  • THEN add the segment-specific narrative action and camera movement\n"
        f"  • Use timestamp shot control: {timestamps}\n"
        "  • Each segment must be COMPLETE and SELF-CONTAINED (readable without the other)\n"
        "  • The END of Part 1 should visually hand off to Part 2 naturally\n\n"

        "═══ HARD RULES ═══\n"
        "  ✗ NEVER repeat the same shot composition, camera angle, or action across segments\n"
        "  ✗ NEVER use quotation marks (renders as on-screen text in Veo/Grok)\n"
        "  ✗ NEVER include text overlays, subtitles, or captions\n"
        "  ✗ NEVER change the product appearance, color, or brand identity between segments\n"
        "  ✓ Each segment must feel like it belongs to the SAME video shoot\n"
        "  ✓ Include the compliance suffix from the original prompt if present\n"
        "  ✓ Write in English only\n\n"

        'Output ONLY valid JSON: {"part1": "...", "part2": "..."}'
    )


# Pre-built system prompts for common durations (lazy-initialized on first use)
def _get_prompt_split_system_16s() -> str:
    return _build_prompt_split_system(segment_duration=8, total_duration=16)


def _get_prompt_split_system_12s() -> str:
    return _build_prompt_split_system(segment_duration=6, total_duration=12)


# Keep legacy constant for backward compatibility
PROMPT_SPLIT_SYSTEM = _get_prompt_split_system_16s()


def split_prompt_for_ns(
    original_prompt: str,
    *,
    api_base: str,
    api_key: str,
    model: str = "gpt-4o-mini",
    proxy: str = "",
    segment_duration: int = 8,
    total_duration: int = 16,
) -> Dict[str, str]:
    """Split a video prompt into two non-overlapping segments for multi-segment generation.

    Args:
        segment_duration: Duration of each segment in seconds (e.g., 8 for 16s, 6 for 12s).
        total_duration: Total target duration in seconds (must be 2 * segment_duration).
    """
    system_prompt = _build_prompt_split_system(segment_duration=segment_duration, total_duration=total_duration)
    messages = [
        {"role": "system", "content": system_prompt},
        {
            "role": "user",
            "content": (
                f"Split this into 2 segments of {segment_duration}s each (total {total_duration}s).\n"
                f"Preserve ALL visual anchors faithfully. Make each segment narratively distinct.\n\n"
                f"Original prompt:\n{original_prompt}"
            ),
        },
    ]
    status_code, data_wrap = call_litellm_chat(
        api_base=api_base,
        api_key=api_key,
        model=model,
        messages=messages,
        proxy=proxy,
        temperature=0.25,
        max_tokens=1600,
    )
    if not data_wrap.get("ok"):
        raise RuntimeError(f"Prompt split LLM call failed (status={status_code})")
    content = extract_chat_content(data_wrap.get("response", {}))
    parsed = try_parse_json_object(content)
    part1 = str(parsed.get("part1") or "").strip()
    part2 = str(parsed.get("part2") or "").strip()
    if not part1 or not part2:
        raise ValueError(
            "LLM did not return valid part1/part2 for prompt split. "
            f"Raw: {content[:300]}"
        )
    return {"part1": part1, "part2": part2}


def split_prompt_for_16s(
    original_prompt: str,
    *,
    api_base: str,
    api_key: str,
    model: str = "gpt-4o-mini",
    proxy: str = "",
) -> Dict[str, str]:
    """Split a prompt into two 8s segments forming a 16s video. Legacy wrapper."""
    return split_prompt_for_ns(
        original_prompt,
        api_base=api_base,
        api_key=api_key,
        model=model,
        proxy=proxy,
        segment_duration=8,
        total_duration=16,
    )


def split_prompt_for_12s(
    original_prompt: str,
    *,
    api_base: str,
    api_key: str,
    model: str = "gpt-4o-mini",
    proxy: str = "",
) -> Dict[str, str]:
    """Split a prompt into two 6s segments forming a 12s video (e.g. for Grok)."""
    return split_prompt_for_ns(
        original_prompt,
        api_base=api_base,
        api_key=api_key,
        model=model,
        proxy=proxy,
        segment_duration=6,
        total_duration=12,
    )
