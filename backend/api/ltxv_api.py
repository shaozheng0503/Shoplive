"""
LTX-Video (ltxv-2.3) API integration — Lightricks  https://api.ltx.video

All generation endpoints are synchronous: they return MP4 binary directly.

Routes:
  POST /api/ltxv/generate        — text-to-video or image-to-video
  POST /api/ltxv/extend          — extend an existing video (pro models)
  POST /api/ltxv/upload-url      — get a pre-signed upload URL
  GET  /api/ltxv/models          — list models + limits
  GET  /api/ltxv/download/<file> — serve a generated file

Environment variables:
  LTXV_API_KEY   — Bearer token (ltxv_...)
  LTXV_API_BASE  — defaults to https://api.ltx.video
  LTXV_MODEL     — default model, e.g. ltx-2-3-pro
"""

import os
import time
import uuid
from pathlib import Path
from typing import Callable, Dict, Optional

import requests
from flask import g, jsonify, send_from_directory

from shoplive.backend.audit import audit_log
from shoplive.backend.validation import validate_request
from shoplive.backend.schemas import LtxvGenerateRequest, LtxvExtendRequest

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------

_DEFAULT_API_BASE = "https://api.ltx.video"
_DEFAULT_MODEL = "ltx-2-3-pro"

# Portrait resolutions require ltx-2.3 models
_PORTRAIT_RESOLUTIONS = {"1080x1920", "1440x2560", "2160x3840"}

# Max duration per (model, resolution) — key: model prefix, value: {res: max_s}
# ltx-2-3-fast at 1080p → 20s; everything else → 10s
def _max_duration(model: str, resolution: str) -> int:
    if model.startswith("ltx-2-3-fast") and resolution in {"1920x1080", "1080x1920"}:
        return 20
    return 10


def _get_api_key() -> str:
    key = os.environ.get("LTXV_API_KEY", "").strip()
    if not key:
        raise RuntimeError(
            "Missing LTXV_API_KEY. Set it in .env and restart the server."
        )
    return key


def _get_api_base() -> str:
    return os.environ.get("LTXV_API_BASE", _DEFAULT_API_BASE).rstrip("/")


def _get_default_model() -> str:
    return os.environ.get("LTXV_MODEL", _DEFAULT_MODEL).strip() or _DEFAULT_MODEL


def _headers(api_key: str) -> Dict[str, str]:
    return {"Authorization": f"Bearer {api_key}"}


def _resolve_image(
    image_url: Optional[str],
    image_base64: Optional[str],
    fetch_fn: Optional[Callable],
) -> Optional[str]:
    """Return image_uri value or None."""
    if image_base64:
        b64 = image_base64
        if not b64.startswith("data:"):
            b64 = f"data:image/jpeg;base64,{b64}"
        return b64
    if image_url and fetch_fn:
        mime, b64 = fetch_fn(image_url, "")
        return f"data:{mime};base64,{b64}"
    return image_url  # raw URL (API accepts HTTPS URLs)


def _call_ltxv(endpoint: str, body: Dict, api_key: str, timeout: int = 300) -> requests.Response:
    """POST to the LTX-Video API and return the raw response."""
    return requests.post(
        endpoint,
        json=body,
        headers=_headers(api_key),
        timeout=timeout,
        stream=True,
    )


def _save_video(resp: requests.Response, export_dir: Path, prefix: str = "ltxv") -> str:
    """Stream MP4 response body to disk, return filename."""
    filename = f"{prefix}_{uuid.uuid4().hex[:12]}.mp4"
    out_path = export_dir / filename
    with open(out_path, "wb") as f:
        for chunk in resp.iter_content(chunk_size=65536):
            if chunk:
                f.write(chunk)
    return filename


def _api_error_msg(resp: requests.Response) -> str:
    try:
        data = resp.json()
        return data.get("error", {}).get("message") or str(data)
    except Exception:
        return resp.text[:300]


# ---------------------------------------------------------------------------
# Route registration
# ---------------------------------------------------------------------------

def register_ltxv_routes(
    app,
    *,
    json_error: Callable,
    build_proxies: Callable,
    fetch_image_as_base64: Callable = None,
    video_export_dir: Path = None,
):
    export_dir: Path = video_export_dir or (Path(__file__).parent.parent.parent / "video_edits")
    export_dir.mkdir(parents=True, exist_ok=True)

    # ------------------------------------------------------------------
    # File download
    # ------------------------------------------------------------------
    @app.get("/api/ltxv/download/<path:filename>")
    def api_ltxv_download(filename):
        return send_from_directory(str(export_dir), filename)

    # ------------------------------------------------------------------
    # POST /api/ltxv/generate  — text-to-video / image-to-video
    # ------------------------------------------------------------------
    @app.post("/api/ltxv/generate")
    @validate_request(LtxvGenerateRequest)
    def api_ltxv_generate():
        req: LtxvGenerateRequest = g.req
        t0 = time.time()

        try:
            api_key = _get_api_key()
        except RuntimeError as exc:
            return json_error(str(exc), 500, "Set LTXV_API_KEY in .env and restart.")

        api_base = _get_api_base()
        model = req.model.strip() if req.model and req.model.strip() else _get_default_model()

        # Validate portrait orientation — only ltx-2.3 models
        if req.resolution in _PORTRAIT_RESOLUTIONS and not model.startswith("ltx-2-3"):
            return json_error(
                f"Portrait resolution {req.resolution} requires a ltx-2-3-* model.",
                400,
                "Change model to ltx-2-3-pro or ltx-2-3-fast.",
            )

        # Duration cap
        max_dur = _max_duration(model, req.resolution)
        duration = min(req.duration, max_dur)

        # Resolve images for image-to-video
        is_image_mode = bool(req.image_url or req.image_base64)
        image_uri: Optional[str] = None
        last_frame_uri: Optional[str] = None

        if is_image_mode:
            try:
                image_uri = _resolve_image(req.image_url, req.image_base64, fetch_image_as_base64)
            except Exception as exc:
                return json_error(f"Failed to fetch first-frame image: {exc}", 400,
                                  "Check image_url or provide image_base64.")

        if req.last_frame_url or req.last_frame_base64:
            if not model.startswith("ltx-2-3"):
                return json_error(
                    "last_frame_url/last_frame_base64 requires a ltx-2-3-* model.", 400,
                    "Change model to ltx-2-3-pro or ltx-2-3-fast.",
                )
            try:
                last_frame_uri = _resolve_image(req.last_frame_url, req.last_frame_base64, fetch_image_as_base64)
            except Exception as exc:
                return json_error(f"Failed to fetch last-frame image: {exc}", 400)

        # Build body
        if is_image_mode:
            endpoint = f"{api_base}/v1/image-to-video"
            body: Dict = {"image_uri": image_uri, "prompt": req.prompt}
            if last_frame_uri:
                body["last_frame_uri"] = last_frame_uri
        else:
            endpoint = f"{api_base}/v1/text-to-video"
            body = {"prompt": req.prompt}

        body.update({
            "model": model,
            "duration": duration,
            "resolution": req.resolution,
            "fps": req.fps,
            "generate_audio": req.generate_audio,
        })
        if req.camera_motion:
            body["camera_motion"] = req.camera_motion

        audit_log.record(
            tool="generate_video_ltxv",
            action="ltxv_submit",
            input_summary={
                "model": model,
                "mode": "image2video" if is_image_mode else "text2video",
                "duration": duration,
                "resolution": req.resolution,
            },
            output_summary={},
            status="success",
            duration_ms=0,
        )

        try:
            resp = _call_ltxv(endpoint, body, api_key)
        except requests.exceptions.RequestException as exc:
            return json_error(f"LTX-Video request failed: {exc}", 502,
                              "Check LTXV_API_BASE and network.")

        if not resp.ok:
            err = _api_error_msg(resp)
            hint = (
                "Check LTXV_API_KEY." if resp.status_code == 401
                else "Safety filter triggered — rephrase the prompt." if resp.status_code == 422
                else "Rate limit — wait and retry." if resp.status_code == 429
                else "LTX-Video server error."
            )
            audit_log.record(
                tool="generate_video_ltxv", action="ltxv_api_error",
                input_summary={"model": model, "status_code": resp.status_code},
                output_summary={"error": err[:120]},
                status="error", error_code="LTXV_API_ERROR",
                duration_ms=int((time.time() - t0) * 1000),
            )
            return json_error(f"LTX-Video error ({resp.status_code}): {err}", resp.status_code, hint)

        try:
            filename = _save_video(resp, export_dir)
        except Exception as exc:
            return json_error(f"Failed to save video: {exc}", 500)

        dur_ms = int((time.time() - t0) * 1000)
        audit_log.record(
            tool="generate_video_ltxv", action="ltxv_done",
            input_summary={"model": model, "duration": duration},
            output_summary={"file": filename, "request_id": resp.headers.get("x-request-id", "")},
            status="success", duration_ms=dur_ms,
        )

        return jsonify({
            "status": "completed",
            "video_url": f"/api/ltxv/download/{filename}",
            "filename": filename,
            "model": model,
            "resolution": req.resolution,
            "duration": duration,
            "request_id": resp.headers.get("x-request-id", ""),
            "duration_ms": dur_ms,
        })

    # ------------------------------------------------------------------
    # POST /api/ltxv/extend  — extend an existing video (pro models only)
    # ------------------------------------------------------------------
    @app.post("/api/ltxv/extend")
    @validate_request(LtxvExtendRequest)
    def api_ltxv_extend():
        req: LtxvExtendRequest = g.req
        t0 = time.time()

        try:
            api_key = _get_api_key()
        except RuntimeError as exc:
            return json_error(str(exc), 500)

        api_base = _get_api_base()
        model = req.model.strip() if req.model.strip() else "ltx-2-3-pro"

        if not model.endswith("-pro"):
            return json_error(
                "extend requires a pro model (ltx-2-3-pro or ltx-2-pro).", 400,
                "Change model to ltx-2-3-pro.",
            )

        body: Dict = {
            "video_uri": req.video_url,
            "duration": req.duration,
            "mode": req.mode,
            "model": model,
        }
        if req.prompt:
            body["prompt"] = req.prompt

        try:
            resp = _call_ltxv(f"{api_base}/v1/extend", body, api_key)
        except requests.exceptions.RequestException as exc:
            return json_error(f"LTX-Video extend request failed: {exc}", 502)

        if not resp.ok:
            err = _api_error_msg(resp)
            return json_error(f"LTX-Video extend error ({resp.status_code}): {err}", resp.status_code)

        try:
            filename = _save_video(resp, export_dir, prefix="ltxv_ext")
        except Exception as exc:
            return json_error(f"Failed to save extended video: {exc}", 500)

        dur_ms = int((time.time() - t0) * 1000)
        audit_log.record(
            tool="extend_video_ltxv", action="ltxv_extend_done",
            input_summary={"model": model, "duration": req.duration, "mode": req.mode},
            output_summary={"file": filename},
            status="success", duration_ms=dur_ms,
        )

        return jsonify({
            "status": "completed",
            "video_url": f"/api/ltxv/download/{filename}",
            "filename": filename,
            "model": model,
            "duration_ms": dur_ms,
        })

    # ------------------------------------------------------------------
    # POST /api/ltxv/upload-url  — get pre-signed upload URL for large files
    # ------------------------------------------------------------------
    @app.post("/api/ltxv/upload-url")
    def api_ltxv_upload_url():
        """Get a pre-signed URL to upload a large video/image/audio file.

        The returned storage_uri can then be used in generate/extend as image_url or video_url.
        """
        try:
            api_key = _get_api_key()
        except RuntimeError as exc:
            return json_error(str(exc), 500)

        try:
            resp = requests.post(
                f"{_get_api_base()}/v1/upload",
                headers=_headers(api_key),
                timeout=15,
            )
        except requests.exceptions.RequestException as exc:
            return json_error(f"Upload URL request failed: {exc}", 502)

        if not resp.ok:
            return json_error(f"LTX-Video upload error ({resp.status_code}): {_api_error_msg(resp)}", resp.status_code)

        return jsonify(resp.json())

    # ------------------------------------------------------------------
    # GET /api/ltxv/models
    # ------------------------------------------------------------------
    @app.get("/api/ltxv/models")
    def api_ltxv_models():
        """List available models with their capabilities and duration limits."""
        models = [
            {
                "id": "ltx-2-3-pro",
                "series": "LTX-2.3",
                "tier": "pro",
                "description": "Best quality. Supports portrait, audio-to-video, retake, extend.",
                "max_duration_1080p": 10,
                "supports_portrait": True,
                "supports_last_frame": True,
                "supports_extend": True,
                "recommended": True,
            },
            {
                "id": "ltx-2-3-fast",
                "series": "LTX-2.3",
                "tier": "fast",
                "description": "Fast generation. Up to 20s at 1080p. Supports portrait.",
                "max_duration_1080p": 20,
                "supports_portrait": True,
                "supports_last_frame": True,
                "supports_extend": False,
                "recommended": False,
            },
            {
                "id": "ltx-2-pro",
                "series": "LTX-2",
                "tier": "pro",
                "description": "LTX-2 Pro. Landscape only. Supports extend.",
                "max_duration_1080p": 10,
                "supports_portrait": False,
                "supports_last_frame": False,
                "supports_extend": True,
                "recommended": False,
            },
            {
                "id": "ltx-2-fast",
                "series": "LTX-2",
                "tier": "fast",
                "description": "LTX-2 Fast. Landscape only.",
                "max_duration_1080p": 10,
                "supports_portrait": False,
                "supports_last_frame": False,
                "supports_extend": False,
                "recommended": False,
            },
        ]
        resolutions = {
            "landscape": ["1920x1080", "2560x1440", "3840x2160"],
            "portrait_ltx23_only": ["1080x1920", "1440x2560", "2160x3840"],
        }
        return jsonify({
            "active_default": _get_default_model(),
            "models": models,
            "resolutions": resolutions,
        })
