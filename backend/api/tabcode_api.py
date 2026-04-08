"""
Tabcode video generation API adapter.

Calls https://chat.tabcode.cc/v1/chat/completions with streaming SSE and
extracts the final video URL from the <video src="..."> HTML tag in the
last content chunk.  Returns progress events so the frontend can display
a live progress bar without polling.

Response shape (SSE):
    data: {"type": "progress", "percent": 48}
    data: {"type": "done",     "video_url": "http://...generated_video.mp4"}
    data: {"type": "error",    "message": "..."}
    data: [DONE]
"""
import json
import os
import re
import time
from typing import Generator

import requests
from flask import Flask, Response, g, jsonify, request

from shoplive.backend.audit import AuditedOp, audit_log
from shoplive.backend.common.helpers import json_error

_TABCODE_API_BASE = os.getenv("TABCODE_API_BASE", "https://chat.tabcode.cc")
_TABCODE_API_KEY  = os.getenv("TABCODE_API_KEY",  "")

_DEFAULT_VIDEO_MODEL = "grok-imagine-1.0-video"

# Matches: src="http://..." type="video/mp4"
_VIDEO_SRC_RE = re.compile(r'src=["\']([^"\']+\.mp4)["\']', re.IGNORECASE)
# Matches: poster="http://..."
_POSTER_SRC_RE = re.compile(r'poster=["\']([^"\']+)["\']', re.IGNORECASE)
# Matches: 进度X% or progress X%
_PROGRESS_RE = re.compile(r'(\d+)\s*%', re.IGNORECASE)


def _stream_tabcode_video(prompt: str, model: str, aspect_ratio: str = "16:9") -> Generator[str, None, None]:
    """
    Call tabcode API, stream SSE back to frontend with progress + final URL.
    Each yielded string is a raw SSE line (ends with \\n\\n).
    """
    api_base = _TABCODE_API_BASE.rstrip("/")
    api_key  = _TABCODE_API_KEY
    if not api_key:
        yield _sse_event({"type": "error", "message": "TABCODE_API_KEY not configured"})
        return

    url = f"{api_base}/v1/chat/completions"
    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
        "Accept": "text/event-stream",
    }
    # Map ratio string to pixel size (common format for video/image generation APIs)
    _SIZE_MAP = {"9:16": "1080x1920", "16:9": "1920x1080", "1:1": "1080x1080"}
    size = _SIZE_MAP.get(aspect_ratio, "1920x1080")
    payload = {
        "model": model or _DEFAULT_VIDEO_MODEL,
        "messages": [{"role": "user", "content": prompt}],
        "stream": True,
        "max_tokens": 1024,
        # Pass aspect ratio as both ratio string and pixel size — providers vary on which they accept
        "aspect_ratio": aspect_ratio,
        "size": size,
    }

    try:
        resp = requests.post(url, headers=headers, json=payload, stream=True, timeout=(15, 120))
        if not resp.ok:
            yield _sse_event({"type": "error", "message": f"API error {resp.status_code}: {resp.text[:200]}"})
            return
    except requests.RequestException as exc:
        yield _sse_event({"type": "error", "message": str(exc)})
        return

    video_url   = ""
    poster_url  = ""
    last_pct    = -1

    for raw_line in resp.iter_lines():
        if not raw_line:
            continue
        line = raw_line.decode("utf-8", errors="replace") if isinstance(raw_line, bytes) else raw_line
        if not line.startswith("data:"):
            continue
        data_str = line[5:].strip()
        if data_str == "[DONE]":
            break

        try:
            chunk = json.loads(data_str)
        except json.JSONDecodeError:
            continue

        delta_content = chunk.get("choices", [{}])[0].get("delta", {}).get("content", "")
        if not delta_content:
            continue

        # --- Extract progress percent ---
        pct_match = _PROGRESS_RE.search(delta_content)
        if pct_match:
            pct = int(pct_match.group(1))
            if pct != last_pct:
                last_pct = pct
                yield _sse_event({"type": "progress", "percent": pct})
            continue

        # --- Extract video URL from <video> HTML tag ---
        src_match = _VIDEO_SRC_RE.search(delta_content)
        if src_match:
            video_url = src_match.group(1)
        poster_match = _POSTER_SRC_RE.search(delta_content)
        if poster_match:
            poster_url = poster_match.group(1)

    if video_url:
        yield _sse_event({
            "type":       "done",
            "video_url":  video_url,
            "poster_url": poster_url,
        })
    else:
        yield _sse_event({"type": "error", "message": "Video URL not found in API response"})

    yield "data: [DONE]\n\n"


def _sse_event(payload: dict) -> str:
    return f"data: {json.dumps(payload, ensure_ascii=False)}\n\n"


def register_tabcode_routes(app: Flask, **_kwargs) -> None:
    """Register /api/tabcode/* routes onto the Flask app."""

    @app.post("/api/tabcode/video/generate")
    def api_tabcode_video_generate():
        """
        Stream Grok / tabcode video generation with live progress.

        Request body:
            prompt  (str, required)   – the video generation prompt
            model   (str, optional)   – defaults to grok-imagine-1.0-video

        Response: text/event-stream SSE
            {"type":"progress","percent":N}
            {"type":"done","video_url":"http://...mp4","poster_url":"..."}
            {"type":"error","message":"..."}
            [DONE]
        """
        _t0          = time.monotonic()
        body         = request.get_json(silent=True) or {}
        prompt       = str(body.get("prompt")       or "").strip()
        model        = str(body.get("model")        or _DEFAULT_VIDEO_MODEL).strip()
        aspect_ratio = str(body.get("aspect_ratio") or "16:9").strip()

        if not prompt:
            return json_error("prompt is required", 400)

        def generate():
            _status = "error"
            _out = {}
            try:
                for event in _stream_tabcode_video(prompt, model, aspect_ratio):
                    yield event
                    # Peek at the last meaningful event to determine final status
                    if event.startswith("data:") and "[DONE]" not in event:
                        try:
                            _evt = json.loads(event[5:].strip())
                            if _evt.get("type") == "done":
                                _status = "success"
                                _out = {"video_url_present": bool(_evt.get("video_url"))}
                            elif _evt.get("type") == "error":
                                _out = {"error": _evt.get("message", "")[:200]}
                        except (json.JSONDecodeError, ValueError):
                            pass
            except Exception as exc:
                _out = {"error": str(exc)[:200]}
                yield _sse_event({"type": "error", "message": str(exc)})
                yield "data: [DONE]\n\n"
            finally:
                audit_log.record(
                    tool="tabcode_video", action="generate",
                    input_summary={"model": model, "prompt_length": len(prompt), "aspect_ratio": aspect_ratio},
                    output_summary=_out,
                    status=_status, duration_ms=int((time.monotonic() - _t0) * 1000),
                )

        return Response(generate(), mimetype="text/event-stream",
                        headers={"X-Accel-Buffering": "no", "Cache-Control": "no-cache"})

    @app.get("/api/tabcode/models")
    def api_tabcode_models():
        """Return available tabcode models (static list from API discovery)."""
        op = AuditedOp("tabcode_models", "list")
        models = [
            {"id": "grok-imagine-1.0-video",  "label": "Grok Video 1.0",       "type": "video"},
            {"id": "grok-imagine-1.0",        "label": "Grok Image 1.0",       "type": "image"},
            {"id": "grok-4.1-fast",           "label": "Grok 4.1 Fast (chat)", "type": "chat"},
            {"id": "grok-4",                  "label": "Grok 4 (chat)",        "type": "chat"},
        ]
        op.success({"model_count": len(models)})
        return jsonify({"ok": True, "models": models})
