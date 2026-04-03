"""
即梦 (Jimeng) API integration — ByteDance video/image generation proxy.

Base URL: http://43.163.110.48  (token-based proxy for Dreamina/即梦)

Routes:
  POST /api/jimeng/video   — text/image/first-last-frame video generation
  POST /api/jimeng/image   — text/image-to-image generation
  GET  /api/jimeng/models  — list models and credit costs

Notes:
  - Content-Type to upstream: multipart/form-data
  - Timeout: 1200s (20 min) as per provider requirement
  - Returned video URLs are external CDN (may require proxy to download)
  - Image files must be < 2MB
  - Rate limit: 5 req/s, 30 req/min

Env vars:
  JIMENG_API_KEY   — Bearer token (format: xxxx-xxxx-xxxx-xxxx)
  JIMENG_API_BASE  — defaults to http://43.163.110.48
"""

import io
import os
import time
from typing import Callable, Dict, Optional, Tuple

import requests
from flask import g, jsonify

from shoplive.backend.audit import audit_log
from shoplive.backend.validation import validate_request
from shoplive.backend.schemas import JimengVideoRequest, JimengImageRequest

_DEFAULT_API_BASE = "http://43.163.110.48"
_TIMEOUT = 1200  # 20 minutes per provider docs

# Credit costs per call
_CREDITS = {
    "3.5-pro": 3,
    "3.0": 2,
    "jimeng-5.0": 1,
    "jimeng-4.6": 1,
    "jimeng-4.5": 1,
    "jimeng-4.1": 1,
    "jimeng-4.0": 1,
    "nanobanana": 2,
}


def _get_api_key() -> str:
    key = os.environ.get("JIMENG_API_KEY", "").strip()
    if not key:
        raise RuntimeError("Missing JIMENG_API_KEY. Set it in .env and restart.")
    return key


def _get_api_base() -> str:
    return os.environ.get("JIMENG_API_BASE", _DEFAULT_API_BASE).rstrip("/")


def _auth_headers(api_key: str) -> Dict[str, str]:
    return {"Authorization": f"Bearer {api_key}"}


def _base64_to_bytes(b64: str) -> Tuple[bytes, str]:
    """Strip data URI prefix and decode. Returns (bytes, mime_type)."""
    import base64
    if b64.startswith("data:"):
        header, data = b64.split(",", 1)
        mime = header.split(":")[1].split(";")[0]
    else:
        data = b64
        mime = "image/jpeg"
    return base64.b64decode(data), mime


def _ext_from_mime(mime: str) -> str:
    return {"image/jpeg": "jpg", "image/png": "png", "image/webp": "webp"}.get(mime, "jpg")


def _resolve_image_bytes(
    image_url: Optional[str],
    image_base64: Optional[str],
    proxies: Dict,
) -> Optional[Tuple[bytes, str]]:
    """Return (file_bytes, filename) or None."""
    if image_base64:
        raw, mime = _base64_to_bytes(image_base64)
        return raw, f"image.{_ext_from_mime(mime)}"
    if image_url:
        resp = requests.get(image_url, proxies=proxies, timeout=30)
        resp.raise_for_status()
        mime = resp.headers.get("Content-Type", "image/jpeg").split(";")[0]
        return resp.content, f"image.{_ext_from_mime(mime)}"
    return None


# ---------------------------------------------------------------------------
# Route registration
# ---------------------------------------------------------------------------

def register_jimeng_routes(
    app,
    *,
    json_error: Callable,
    build_proxies: Callable,
):
    # ------------------------------------------------------------------
    # POST /api/jimeng/video
    # ------------------------------------------------------------------
    @app.post("/api/jimeng/video")
    @validate_request(JimengVideoRequest)
    def api_jimeng_video():
        """Generate video with Jimeng 即梦.

        Supports:
        - Text-to-video: just provide prompt
        - Image-to-video: add image_url or image_base64
        - First-last-frame: add both image_url and last_frame_url
        """
        req: JimengVideoRequest = g.req
        t0 = time.time()

        try:
            api_key = _get_api_key()
        except RuntimeError as exc:
            return json_error(str(exc), 500, "Set JIMENG_API_KEY in .env and restart.")

        api_base = _get_api_base()
        proxies = build_proxies(req.proxy) if req.proxy else {}

        # Choose endpoint by model
        endpoint = (
            f"{api_base}/api/generations/jimeng/videos/3-5-pro"
            if req.model == "3.5-pro"
            else f"{api_base}/api/generations/jimeng/videos"
        )

        # Build multipart form data
        data: Dict[str, str] = {
            "prompt": req.prompt,
            "ratio": req.ratio,
            "duration": str(req.duration),
            "resolution": req.resolution,
        }
        files: Dict = {}

        # First frame image
        if req.image_url or req.image_base64:
            try:
                img_bytes, img_name = _resolve_image_bytes(
                    req.image_url, req.image_base64, proxies
                )
                # Check 2MB limit
                if len(img_bytes) > 2 * 1024 * 1024:
                    return json_error(
                        f"First-frame image too large ({len(img_bytes)//1024}KB). Max 2MB.",
                        400,
                        "Compress or resize the image before sending.",
                    )
                files["image_file_1"] = (img_name, io.BytesIO(img_bytes), "image/jpeg")
            except Exception as exc:
                return json_error(f"Failed to fetch first-frame image: {exc}", 400)

        # Last frame image (first-last-frame mode)
        if req.last_frame_url or req.last_frame_base64:
            try:
                lf_bytes, lf_name = _resolve_image_bytes(
                    req.last_frame_url, req.last_frame_base64, proxies
                )
                if len(lf_bytes) > 2 * 1024 * 1024:
                    return json_error(
                        f"Last-frame image too large ({len(lf_bytes)//1024}KB). Max 2MB.", 400
                    )
                files["image_file_2"] = (lf_name, io.BytesIO(lf_bytes), "image/jpeg")
            except Exception as exc:
                return json_error(f"Failed to fetch last-frame image: {exc}", 400)

        mode = (
            "first_last_frame" if files.get("image_file_2")
            else "image2video" if files.get("image_file_1")
            else "text2video"
        )
        credits = _CREDITS.get(req.model, "?")

        audit_log.record(
            tool="generate_video_jimeng",
            action="jimeng_video_submit",
            input_summary={
                "model": req.model,
                "mode": mode,
                "duration": req.duration,
                "ratio": req.ratio,
                "credits": credits,
            },
            output_summary={},
            status="success",
            duration_ms=0,
        )

        try:
            resp = requests.post(
                endpoint,
                headers=_auth_headers(api_key),
                data=data,
                files=files if files else None,
                proxies=proxies,
                timeout=_TIMEOUT,
            )
        except requests.exceptions.Timeout:
            return json_error(
                "Jimeng API timeout (>20min). This is normal during peak hours.",
                504,
                "Please retry. High-traffic periods can queue 1+ hour.",
            )
        except requests.exceptions.RequestException as exc:
            return json_error(f"Jimeng API request failed: {exc}", 502,
                              "Check JIMENG_API_BASE and network.")

        dur_ms = int((time.time() - t0) * 1000)

        if not resp.ok:
            try:
                err_body = resp.json()
            except Exception:
                err_body = {"raw": resp.text[:300]}
            audit_log.record(
                tool="generate_video_jimeng",
                action="jimeng_video_error",
                input_summary={"model": req.model, "status_code": resp.status_code},
                output_summary={"error": str(err_body)[:120]},
                status="error",
                error_code="JIMENG_API_ERROR",
                duration_ms=dur_ms,
            )
            return json_error(
                f"Jimeng API error ({resp.status_code}): {err_body}",
                resp.status_code,
                "Check JIMENG_API_KEY. If 500, check image size (<2MB).",
            )

        result = resp.json()
        videos = result.get("data", [])
        video_urls = [v.get("url") for v in videos if v.get("url")]

        audit_log.record(
            tool="generate_video_jimeng",
            action="jimeng_video_done",
            input_summary={"model": req.model, "mode": mode},
            output_summary={"count": len(video_urls), "credits_used": credits},
            status="success",
            duration_ms=dur_ms,
        )

        return jsonify({
            "status": "completed",
            "model": f"jimeng-video-{req.model}",
            "mode": mode,
            "video_urls": video_urls,
            "credits_used": credits,
            "duration_seconds": req.duration,
            "ratio": req.ratio,
            "elapsed_seconds": round(dur_ms / 1000, 1),
            "note": "video_urls are external CDN links — VPN/proxy may be required to download.",
            "raw": result,
        })

    # ------------------------------------------------------------------
    # POST /api/jimeng/image
    # ------------------------------------------------------------------
    @app.post("/api/jimeng/image")
    @validate_request(JimengImageRequest)
    def api_jimeng_image():
        """Generate images with Jimeng 即梦 (文生图 / 图生图)."""
        req: JimengImageRequest = g.req
        t0 = time.time()

        try:
            api_key = _get_api_key()
        except RuntimeError as exc:
            return json_error(str(exc), 500)

        api_base = _get_api_base()
        proxies = build_proxies(req.proxy) if req.proxy else {}
        endpoint = f"{api_base}/api/generations/jimeng/images"

        data: Dict[str, str] = {
            "model": req.model,
            "prompt": req.prompt,
            "ratio": req.ratio,
            "resolution": req.resolution,
        }
        files: Dict = {}

        if req.image_url or req.image_base64:
            try:
                img_bytes, img_name = _resolve_image_bytes(
                    req.image_url, req.image_base64, proxies
                )
                if len(img_bytes) > 2 * 1024 * 1024:
                    return json_error(
                        f"Image too large ({len(img_bytes)//1024}KB). Max 2MB.", 400
                    )
                files["images"] = (img_name, io.BytesIO(img_bytes), "image/jpeg")
            except Exception as exc:
                return json_error(f"Failed to fetch reference image: {exc}", 400)

        mode = "image2image" if files else "text2image"
        base_credits = _CREDITS.get(req.model, 1)
        credits = base_credits + (2 if req.resolution == "4k" else 0)

        try:
            resp = requests.post(
                endpoint,
                headers=_auth_headers(api_key),
                data=data,
                files=files if files else None,
                proxies=proxies,
                timeout=_TIMEOUT,
            )
        except requests.exceptions.Timeout:
            return json_error("Jimeng image API timeout.", 504)
        except requests.exceptions.RequestException as exc:
            return json_error(f"Jimeng API request failed: {exc}", 502)

        dur_ms = int((time.time() - t0) * 1000)

        if not resp.ok:
            try:
                err_body = resp.json()
            except Exception:
                err_body = {"raw": resp.text[:300]}
            return json_error(
                f"Jimeng image API error ({resp.status_code}): {err_body}",
                resp.status_code,
            )

        result = resp.json()
        images = result.get("data", [])
        image_urls = [img.get("url") for img in images if img.get("url")]

        audit_log.record(
            tool="generate_image_jimeng",
            action="jimeng_image_done",
            input_summary={"model": req.model, "mode": mode, "resolution": req.resolution},
            output_summary={"count": len(image_urls), "credits_used": credits},
            status="success",
            duration_ms=dur_ms,
        )

        return jsonify({
            "status": "completed",
            "model": req.model,
            "mode": mode,
            "image_urls": image_urls,
            "count": len(image_urls),
            "credits_used": credits,
            "elapsed_seconds": round(dur_ms / 1000, 1),
            "raw": result,
        })

    # ------------------------------------------------------------------
    # GET /api/jimeng/models
    # ------------------------------------------------------------------
    @app.get("/api/jimeng/models")
    def api_jimeng_models():
        """List Jimeng models with credit costs and capabilities."""
        return jsonify({
            "video": [
                {"id": "3.5-pro", "endpoint": "/api/jimeng/video", "credits": 3,
                 "description": "即梦 3.5 Pro — 最高质量，支持首尾帧", "max_duration": 10},
                {"id": "3.0",     "endpoint": "/api/jimeng/video", "credits": 2,
                 "description": "即梦 3.0 — 标准质量，支持首尾帧", "max_duration": 10},
            ],
            "image": [
                {"id": "jimeng-5.0",  "credits_2k": 1, "credits_4k": 3},
                {"id": "jimeng-4.6",  "credits_2k": 1, "credits_4k": 3},
                {"id": "jimeng-4.5",  "credits_2k": 1, "credits_4k": 3},
                {"id": "jimeng-4.1",  "credits_2k": 1, "credits_4k": 3},
                {"id": "jimeng-4.0",  "credits_2k": 1, "credits_4k": 3},
                {"id": "nanobanana",  "credits_2k": 2, "credits_4k": "N/A (max 1k)"},
            ],
            "rate_limits": {"per_second": 5, "per_minute": 30},
            "timeout_seconds": 1200,
            "notes": [
                "video_urls in response are external CDN — VPN required to download",
                "image files must be < 2MB",
                "duration: 5 or 10 seconds only",
            ],
        })
