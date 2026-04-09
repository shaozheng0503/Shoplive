import base64
import logging
import os
import random
import shutil
import subprocess
import tempfile
import time
import re
import threading
import uuid

logger = logging.getLogger(__name__)
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
from typing import Callable, Dict, List, Tuple

import requests
from flask import Response, g, jsonify, request, stream_with_context
from google.cloud import storage
from google.oauth2 import service_account

from shoplive.backend.audit import audit_log
from shoplive.backend.common.helpers import mitigate_veo_temporal_flicker
from shoplive.backend.validation import validate_request
from shoplive.backend.schemas import VeoStartRequest, VeoStatusRequest


def _extract_vertex_predict_error_message(data: object) -> str:
    """Human-readable snippet from Vertex predictLongRunning error JSON (4xx/5xx)."""
    if not isinstance(data, dict):
        return (str(data) or "")[:600]
    err = data.get("error")
    if isinstance(err, dict):
        msg = err.get("message") or err.get("status") or ""
        if str(msg).strip():
            return str(msg).strip()[:600]
    if isinstance(err, str) and err.strip():
        return err.strip()[:600]
    return (str(data.get("message") or "") or "")[:600]


def _ensure_opening_exposure_stability(prompt: str) -> str:
    """Reduce visible flash / exposure pop in the first ~2–4s (common Veo artifact)."""
    p = (prompt or "").strip()
    if not p:
        return p
    low = p.lower()
    if "first 0-4 seconds" in low or "0s to 4s" in low:
        return p
    if "lock exposure" in low and ("0-4" in p or "opening" in low):
        return p
    suffix = (
        " First 0-4 seconds: lock exposure and white balance — no flash, no fade-to-white, "
        "no sudden brightening or luminance spike; if lighting changes, ramp smoothly."
    )
    return f"{p.rstrip()}{suffix}"


def register_veo_routes(
    app,
    *,
    json_error: Callable[[str, int], Tuple],
    parse_common_payload: Callable[[Dict], Tuple[str, str, str, str]],
    get_access_token: Callable[[str, str], str],
    build_proxies: Callable[[str], Dict[str, str]],
    normalize_reference_urls: Callable[[object], list],
    normalize_reference_images_base64: Callable[[object], list],
    parse_data_url: Callable[[str], Tuple[str, str]],
    fetch_image_as_base64: Callable[[str, str], Tuple[str, str]],
    normalize_duration_seconds: Callable[[object], int],
    extract_gs_paths: Callable[[object], list],
    extract_inline_videos: Callable[[object], list],
    sign_gcs_url: Callable[[str, str], str],
    split_prompt_for_16s: Callable[..., Dict[str, str]] = None,
    split_prompt_for_12s: Callable[..., Dict[str, str]] = None,
    concat_videos_ffmpeg: Callable[..., Path] = None,
    download_gcs_blob_to_file: Callable[..., Path] = None,
    call_litellm_chat: Callable[..., Tuple[int, Dict]] = None,
    video_export_dir: Path = None,
):
    MAX_INLINE_VIDEO_B64_CHARS = 40 * 1024 * 1024
    MAX_INLINE_VIDEO_BYTES = 30 * 1024 * 1024
    if "veo_status_metrics" not in app.config:
        app.config["veo_status_metrics"] = {
            "total_calls": 0,
            "retried_calls": 0,
            "retry_attempts_total": 0,
            "transient_events": 0,
            "retry_exhausted": 0,
        }
    _veo_status_metrics_lock = threading.Lock()

    # Async chain job store (job_id → state dict)
    # Completed/failed jobs are evicted after CHAIN_JOB_TTL_SECONDS or when
    # the store exceeds CHAIN_JOB_MAX to prevent unbounded memory growth.
    _chain_jobs: Dict[str, Dict] = {}
    _chain_jobs_lock = threading.Lock()
    CHAIN_JOB_TTL_SECONDS = 3600   # 1 hour
    CHAIN_JOB_MAX = 100

    def _update_chain_job(job_id: str, **kwargs):
        now = time.time()
        # O(1) update under lock
        with _chain_jobs_lock:
            job = _chain_jobs.get(job_id)
            if job:
                job.update(kwargs)
                if kwargs.get("status") in {"done", "failed"}:
                    job["finished_at"] = now

        # O(n) cleanup outside lock — runs occasionally, harmless if concurrent
        _cleanup_chain_jobs()

    def _cleanup_chain_jobs():
        """Evict expired and over-limit jobs. Called after each update."""
        now = time.time()
        with _chain_jobs_lock:
            expired = [
                k for k, v in _chain_jobs.items()
                if v.get("status") in {"done", "failed"}
                and now - v.get("finished_at", now) > CHAIN_JOB_TTL_SECONDS
            ]
            for k in expired:
                del _chain_jobs[k]
            # Hard cap
            if len(_chain_jobs) > CHAIN_JOB_MAX:
                terminal = [(k, v.get("finished_at", 0)) for k, v in _chain_jobs.items()
                            if v.get("status") in {"done", "failed"}]
                if terminal:
                    oldest_key = min(terminal, key=lambda x: x[1])[0]
                    del _chain_jobs[oldest_key]

    def _inc_veo_status_metric(key: str, amount: int = 1):
        with _veo_status_metrics_lock:
            metrics = app.config.setdefault("veo_status_metrics", {})
            metrics[key] = int(metrics.get(key, 0)) + int(amount)

    def _write_video_data_url_to_file(data_url: str, output_path: Path) -> None:
        m = re.match(r"^data:(video\/[a-zA-Z0-9.+-]+);base64,(.+)$", str(data_url or "").strip(), re.DOTALL)
        if not m:
            raise ValueError("video_data_url 必须是 data:video/...;base64,... 格式")
        mime_type = str(m.group(1) or "").lower()
        if mime_type not in {"video/mp4", "video/webm", "video/quicktime", "video/x-m4v"}:
            raise ValueError(f"video_data_url 不支持的 mime_type: {mime_type}")
        raw_b64 = m.group(2).strip()
        if not raw_b64:
            raise ValueError("video_data_url base64 内容为空")
        if len(raw_b64) > MAX_INLINE_VIDEO_B64_CHARS:
            raise ValueError("video_data_url 体积过大，请改用 gcs_uri")
        try:
            decoded = base64.b64decode(raw_b64, validate=True)
        except Exception as e:
            raise ValueError(f"video_data_url base64 解码失败: {e}") from e
        if len(decoded) > MAX_INLINE_VIDEO_BYTES:
            raise ValueError("video_data_url 解码后体积过大，请改用 gcs_uri")
        output_path.write_bytes(decoded)
        if (not output_path.exists()) or output_path.stat().st_size < 1024:
            raise ValueError("video_data_url 解码后视频为空或过小")

    def _build_common_generation_parameters(payload: Dict, *, normalize_duration_seconds) -> Tuple[Dict, object, object]:
        sample_count = int(payload.get("sample_count", 1))
        parameters = {"sampleCount": sample_count}
        storage_uri = (payload.get("storage_uri") or "").strip()
        if storage_uri:
            if not storage_uri.startswith("gs://"):
                raise ValueError("storage_uri 必须是 gs:// 开头")
            parameters["storageUri"] = storage_uri
        raw_duration_seconds = payload.get("duration_seconds")
        effective_duration_seconds = None
        if raw_duration_seconds is not None and str(raw_duration_seconds).strip() != "":
            effective_duration_seconds = normalize_duration_seconds(raw_duration_seconds)
            parameters["durationSeconds"] = effective_duration_seconds
        for k, p_key in [
            ("aspectRatio", "aspect_ratio"),
            ("resolution", "resolution"),
            ("negativePrompt", "negative_prompt"),
            ("personGeneration", "person_generation"),
            ("resizeMode", "resize_mode"),
            ("seed", "seed"),
        ]:
            val = payload.get(p_key)
            if val is not None and str(val).strip() != "":
                parameters[k] = val
        # Reduce abrupt flash / brightness pop — especially opening 0–4s (timestamp beats, i2v ramp).
        # merge exposure-stability negatives (append so user negatives stay primary).
        _neg_flash = (
            "strobe, flashing lights, sudden white flash, harsh exposure jump, "
            "brightness spike, flickering, overexposed pop, lens flare burst, "
            "opening flash, intro luminance spike, fade to white at start, "
            "first seconds exposure drift, blown highlights pop, hard exposure cut"
        )
        if parameters.get("negativePrompt"):
            parameters["negativePrompt"] = f"{parameters['negativePrompt']}, {_neg_flash}"
        else:
            parameters["negativePrompt"] = _neg_flash
        return parameters, raw_duration_seconds, effective_duration_seconds

    def _extract_video_uris(operation_payload: Dict) -> list:
        gs_paths = extract_gs_paths(operation_payload)
        video_exts = (".mp4", ".mov", ".webm", ".m4v")
        return [x for x in gs_paths if x.lower().endswith(video_exts)]

    # Thread-local Session for Vertex AI calls — reuses TLS connections within
    # a Flask worker thread, saving ~100-200ms TLS handshake per Veo API call.
    _vertex_session_local = threading.local()

    def _get_vertex_session(proxy: str) -> requests.Session:
        tl = _vertex_session_local
        proxy_key = proxy or ""
        if getattr(tl, "proxy_key", None) != proxy_key or getattr(tl, "session", None) is None:
            sess = requests.Session()
            if proxy_key:
                sess.proxies.update({"http": proxy_key, "https": proxy_key})
            tl.session = sess
            tl.proxy_key = proxy_key
        return tl.session

    def _vertex_post(url: str, headers: Dict, body: Dict, proxy: str) -> requests.Response:
        sess = _get_vertex_session(proxy)
        # (connect_timeout=15s, read_timeout=90s) — fail fast on unreachable host,
        # but give the API time to respond once connected.
        return sess.post(url, headers=headers, json=body, timeout=(15, 90),
                         proxies=build_proxies(proxy))

    def _call_predict_long_running(*, project_id: str, model: str, token: str, proxy: str, body: Dict):
        url = (
            "https://us-central1-aiplatform.googleapis.com/v1/projects/"
            f"{project_id}/locations/us-central1/publishers/google/models/{model}:predictLongRunning"
        )
        headers = {
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json; charset=utf-8",
        }
        resp = _vertex_post(url, headers, body, proxy)
        data = resp.json() if resp.headers.get("content-type", "").find("json") >= 0 else {"raw": resp.text}
        return resp.status_code, resp.ok, data

    def _call_fetch_predict_operation(
        *,
        project_id: str,
        model: str,
        token: str,
        proxy: str,
        operation_name: str,
    ):
        url = (
            "https://us-central1-aiplatform.googleapis.com/v1/projects/"
            f"{project_id}/locations/us-central1/publishers/google/models/{model}:fetchPredictOperation"
        )
        headers = {
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json; charset=utf-8",
        }
        resp = _vertex_post(url, headers, {"operationName": operation_name}, proxy)
        data = resp.json() if resp.headers.get("content-type", "").find("json") >= 0 else {"raw": resp.text}
        return resp.status_code, resp.ok, data

    # Adaptive poll intervals: start fast (3 s) to catch quick completions,
    # then slow down to reduce API quota usage.  Index = poll attempt number.
    _POLL_ADAPTIVE = [3, 5, 8, 12, 12]  # seconds; last value repeats

    def _poll_video_ready(
        *,
        project_id: str,
        model: str,
        token: str,
        proxy: str,
        operation_name: str,
        poll_interval_seconds: int = 6,   # kept for callers that pass it explicitly
        max_wait_seconds: int = 720,
        initial_wait_seconds: int = int(os.environ.get("VEO_POLL_INITIAL_WAIT", "12")),
    ):
        started = time.time()
        last_data = {}
        # Veo needs ~20-30 s to start generating; skip early polls to save quota.
        # Lowered default from 20 s → 12 s: a few extra 404s cost less than the
        # extra 8 s of perceived latency.
        if initial_wait_seconds > 0:
            time.sleep(min(initial_wait_seconds, max_wait_seconds))
        poll_count = 0
        current_interval = float(_POLL_ADAPTIVE[0])
        while time.time() - started <= max_wait_seconds:
            resp_code, _, op_data = _call_fetch_predict_operation(
                project_id=project_id,
                model=model,
                token=token,
                proxy=proxy,
                operation_name=operation_name,
            )
            last_data = op_data
            op_error = (
                op_data.get("error", {}).get("message")
                or op_data.get("response", {}).get("error", {}).get("message")
                or ""
            )
            video_uris = _extract_video_uris(op_data)
            if video_uris:
                return video_uris[0], op_data
            if op_data.get("done") and op_error:
                raise RuntimeError(op_error)
            # Exponential back-off on transient errors; adaptive ramp otherwise.
            if resp_code in (429, 500, 502, 503, 504):
                current_interval = min(current_interval * 1.5, 60.0)
            else:
                current_interval = float(_POLL_ADAPTIVE[min(poll_count, len(_POLL_ADAPTIVE) - 1)])
            poll_count += 1
            time.sleep(max(1, current_interval))
        raise TimeoutError(f"Veo operation 超时（>{max_wait_seconds}s）: {operation_name}")

    @app.post("/api/veo/start")
    @validate_request(VeoStartRequest)
    def api_veo_start():
        """Submit a video generation task to Google Veo.

        Modes: text (prompt-only), image (prompt + first frame), reference (style-consistent).
        Returns operation_name for polling via /api/veo/status.

        Common follow-up: use check_video_status(operation_name) to poll until video is ready.
        """
        _t0 = time.monotonic()
        # Validated schema fields; raw_payload for reference fields not in schema.
        payload = g.req.model_dump()
        raw_payload = request.get_json(silent=True) or {}
        try:
            project_id, key_file, proxy, model = parse_common_payload(payload)
            prompt = _ensure_opening_exposure_stability(g.req.prompt)
            storage_uri = g.req.storage_uri
            sample_count = g.req.sample_count
            veo_mode = g.req.veo_mode
            image_url = g.req.image_url
            image_b64 = g.req.image_base64
            image_mime_type = g.req.image_mime_type
            reference_urls = normalize_reference_urls(raw_payload.get("reference_image_urls"))
            reference_images_base64 = normalize_reference_images_base64(
                raw_payload.get("reference_images_base64")
            )
            reference_type = (raw_payload.get("reference_type") or "asset").strip()
            if not model:
                model = "veo-3.1-generate-preview"
            if not prompt:
                return json_error(
                    "prompt 不能为空",
                    recovery_suggestion="Provide a descriptive 'prompt' for video generation. "
                                        "Use /api/shoplive/video/workflow with action='build_export_prompt' "
                                        "to auto-generate an optimized prompt from product data.",
                    error_code="MISSING_PROMPT",
                )
            if image_b64.startswith("data:image/"):
                image_b64, image_mime_type = parse_data_url(image_b64)

            token = get_access_token(key_file, proxy)
            url = (
                "https://us-central1-aiplatform.googleapis.com/v1/projects/"
                f"{project_id}/locations/us-central1/publishers/google/models/{model}:predictLongRunning"
            )
            headers = {
                "Authorization": f"Bearer {token}",
                "Content-Type": "application/json; charset=utf-8",
            }
            instance = {"prompt": prompt}
            if veo_mode == "image":
                if not image_b64 and not image_url:
                    return json_error("veo_mode=image 时需提供 image_url 或 image_base64")
                if not image_b64 and image_url:
                    image_b64, image_mime_type = fetch_image_as_base64(image_url, proxy)
                instance["image"] = {
                    "bytesBase64Encoded": image_b64,
                    "mimeType": image_mime_type,
                }
            elif veo_mode == "reference":
                if not reference_urls and not reference_images_base64:
                    return json_error(
                        "veo_mode=reference 时 reference_image_urls 或 reference_images_base64 不能为空"
                    )
                refs = []
                for ref in reference_images_base64[:3]:
                    refs.append(
                        {
                            "image": {
                                "bytesBase64Encoded": ref["base64"],
                                "mimeType": ref["mime_type"],
                            },
                            "referenceType": reference_type,
                        }
                    )
                for ref_url in reference_urls[:3]:
                    ref_b64, ref_mime = fetch_image_as_base64(ref_url, proxy)
                    refs.append(
                        {
                            "image": {
                                "bytesBase64Encoded": ref_b64,
                                "mimeType": ref_mime,
                            },
                            "referenceType": reference_type,
                        }
                    )
                instance["referenceImages"] = refs
            elif veo_mode == "frame":
                if not image_b64 and not image_url:
                    return json_error(
                        "veo_mode=frame 时需提供首帧（image_url 或 image_base64）",
                        error_code="MISSING_FIRST_FRAME",
                    )
                if not image_b64 and image_url:
                    image_b64, image_mime_type = fetch_image_as_base64(image_url, proxy)
                instance["image"] = {
                    "bytesBase64Encoded": image_b64,
                    "mimeType": image_mime_type,
                }
                last_frame_b64 = (g.req.last_frame_base64 or "").strip()
                last_frame_mime = (g.req.last_frame_mime_type or "image/png").strip()
                last_frame_url = (g.req.last_frame_url or "").strip()
                if last_frame_b64 and last_frame_b64.startswith("data:image/"):
                    last_frame_b64, last_frame_mime = parse_data_url(last_frame_b64)
                if not last_frame_b64 and last_frame_url:
                    last_frame_b64, last_frame_mime = fetch_image_as_base64(last_frame_url, proxy)
                if not last_frame_b64:
                    return json_error(
                        "veo_mode=frame 时需提供尾帧（last_frame_url 或 last_frame_base64）",
                        error_code="MISSING_LAST_FRAME",
                    )
                instance["lastFrame"] = {
                    "bytesBase64Encoded": last_frame_b64,
                    "mimeType": last_frame_mime,
                }

            parameters, raw_duration_seconds, effective_duration_seconds = _build_common_generation_parameters(
                payload, normalize_duration_seconds=normalize_duration_seconds
            )

            body = {"instances": [instance], "parameters": parameters}
            resp = requests.post(
                url,
                headers=headers,
                json=body,
                timeout=90,
                proxies=build_proxies(proxy),
            )
            data = resp.json() if resp.headers.get("content-type", "").find("json") >= 0 else {"raw": resp.text}
            operation_name = data.get("name") or ""
            _dur_ms = int((time.monotonic() - _t0) * 1000)
            _api_err = "" if resp.ok else _extract_vertex_predict_error_message(data)
            audit_log.record(
                tool="generate_video",
                action="veo_start",
                input_summary={
                    "model": model,
                    "veo_mode": veo_mode,
                    "prompt_length": len(prompt),
                    "has_image": bool(image_b64 or image_url),
                    "has_storage_uri": bool(storage_uri),
                    "duration_seconds": effective_duration_seconds,
                    "sample_count": sample_count,
                },
                output_summary={
                    "ok": resp.ok,
                    "status_code": resp.status_code,
                    "operation_name": operation_name[:80],
                    **({"vertex_error": _api_err[:400]} if _api_err else {}),
                },
                status="success" if resp.ok else "error",
                error_code=None if resp.ok else "VEO_API_ERROR",
                error_message=_api_err[:600] if _api_err else None,
                duration_ms=_dur_ms,
            )
            return jsonify(
                {
                    "ok": resp.ok,
                    "status_code": resp.status_code,
                    "model": model,
                    "veo_mode": veo_mode,
                    "operation_name": operation_name,
                    "requested_duration_seconds": raw_duration_seconds,
                    "effective_duration_seconds": effective_duration_seconds,
                    "response": data,
                }
            ), resp.status_code
        except ValueError as e:
            audit_log.record(
                tool="generate_video",
                action="veo_start",
                input_summary={"prompt_length": len(str(payload.get("prompt") or ""))},
                output_summary={},
                status="validation_error",
                error_message=str(e)[:200],
                duration_ms=int((time.monotonic() - _t0) * 1000),
            )
            return json_error(
                str(e),
                recovery_suggestion="Check project_id, key_file, and proxy settings. "
                                    "Ensure Google Cloud credentials are valid.",
                error_code="VEO_VALIDATION_ERROR",
            )
        except Exception as e:
            audit_log.record(
                tool="generate_video",
                action="veo_start",
                input_summary={"prompt_length": len(str(payload.get("prompt") or ""))},
                output_summary={},
                status="error",
                error_code="VEO_SUBMIT_FAILED",
                error_message=str(e)[:200],
                duration_ms=int((time.monotonic() - _t0) * 1000),
            )
            return json_error(
                f"Veo 提交失败: {e}",
                500,
                recovery_suggestion="Check network connectivity and proxy settings. "
                                    "Verify that the Veo API is accessible and the model name is valid. "
                                    "If authentication failed, check your service account key file.",
                error_code="VEO_SUBMIT_FAILED",
            )

    @app.post("/api/veo/extend")
    def api_veo_extend():
        _t0 = time.monotonic()
        payload = request.get_json(silent=True) or {}
        try:
            project_id, key_file, proxy, model = parse_common_payload(payload)
            prompt = (payload.get("prompt") or "").strip()
            source_video_gcs_uri = (
                payload.get("source_video_gcs_uri")
                or payload.get("video_gcs_uri")
                or payload.get("input_video_gcs_uri")
                or ""
            ).strip()
            if not model:
                model = "veo-3.1-generate-preview"
            if not prompt:
                return json_error("prompt 不能为空")
            if not source_video_gcs_uri:
                return json_error("source_video_gcs_uri 不能为空（需传入待延展的视频 gs:// 路径）")
            if not source_video_gcs_uri.startswith("gs://"):
                return json_error("source_video_gcs_uri 必须是 gs:// 开头")
            if not source_video_gcs_uri.lower().endswith(".mp4"):
                return json_error("source_video_gcs_uri 目前仅支持 mp4 文件")

            token = get_access_token(key_file, proxy)
            url = (
                "https://us-central1-aiplatform.googleapis.com/v1/projects/"
                f"{project_id}/locations/us-central1/publishers/google/models/{model}:predictLongRunning"
            )
            headers = {
                "Authorization": f"Bearer {token}",
                "Content-Type": "application/json; charset=utf-8",
            }
            instance = {
                "prompt": prompt,
                "video": {
                    "gcsUri": source_video_gcs_uri,
                    "mimeType": "video/mp4",
                },
            }
            parameters, raw_duration_seconds, effective_duration_seconds = _build_common_generation_parameters(
                payload, normalize_duration_seconds=normalize_duration_seconds
            )
            body = {"instances": [instance], "parameters": parameters}
            resp = requests.post(
                url,
                headers=headers,
                json=body,
                timeout=90,
                proxies=build_proxies(proxy),
            )
            data = resp.json() if resp.headers.get("content-type", "").find("json") >= 0 else {"raw": resp.text}
            operation_name = data.get("name") or ""
            _dur_ms = int((time.monotonic() - _t0) * 1000)
            audit_log.record(
                tool="extend_video",
                action="veo_extend",
                input_summary={
                    "model": model,
                    "prompt_length": len(prompt),
                    "source_video": source_video_gcs_uri.split("/")[-1],
                    "duration_seconds": effective_duration_seconds,
                },
                output_summary={
                    "ok": resp.ok,
                    "status_code": resp.status_code,
                    "operation_name": operation_name[:80],
                },
                status="success" if resp.ok else "error",
                error_code=None if resp.ok else "VEO_API_ERROR",
                duration_ms=_dur_ms,
            )
            return jsonify(
                {
                    "ok": resp.ok,
                    "status_code": resp.status_code,
                    "model": model,
                    "mode": "extend",
                    "source_video_gcs_uri": source_video_gcs_uri,
                    "operation_name": operation_name,
                    "requested_duration_seconds": raw_duration_seconds,
                    "effective_duration_seconds": effective_duration_seconds,
                    "target_total_seconds": payload.get("target_total_seconds", 16),
                    "response": data,
                }
            ), resp.status_code
        except ValueError as e:
            audit_log.record(
                tool="extend_video",
                action="veo_extend",
                input_summary={"prompt_length": len(str(payload.get("prompt") or ""))},
                output_summary={},
                status="validation_error",
                error_message=str(e)[:200],
                duration_ms=int((time.monotonic() - _t0) * 1000),
            )
            return json_error(str(e))
        except Exception as e:
            audit_log.record(
                tool="extend_video",
                action="veo_extend",
                input_summary={"prompt_length": len(str(payload.get("prompt") or ""))},
                output_summary={},
                status="error",
                error_code="VEO_EXTEND_SUBMIT_FAILED",
                error_message=str(e)[:200],
                duration_ms=int((time.monotonic() - _t0) * 1000),
            )
            return json_error(f"Veo Extend 提交失败: {e}", 500)

    @app.post("/api/veo/chain")
    def api_veo_chain():
        _t0 = time.monotonic()
        payload = request.get_json(silent=True) or {}
        try:
            project_id, key_file, proxy, model = parse_common_payload(payload)
            prompt = _ensure_opening_exposure_stability((payload.get("prompt") or "").strip())
            if not model:
                model = "veo-3.1-generate-preview"
            if not prompt:
                return json_error("prompt 不能为空")
            storage_uri = (payload.get("storage_uri") or "").strip()
            if not storage_uri:
                return json_error("veo 链式生成必须提供 storage_uri（gs://）")
            if not storage_uri.startswith("gs://"):
                return json_error("storage_uri 必须是 gs:// 开头")

            try:
                target_total_seconds = int(payload.get("target_total_seconds") or payload.get("duration_seconds") or 8)
            except Exception:
                target_total_seconds = 8
            if target_total_seconds not in {8, 16, 24}:
                return json_error("target_total_seconds 仅支持 8/16/24")
            extend_rounds = max(0, target_total_seconds // 8 - 1)

            sample_count = int(payload.get("sample_count", 1))
            if sample_count < 1 or sample_count > 4:
                return json_error("sample_count 仅支持 1-4")

            poll_interval_seconds = int(payload.get("poll_interval_seconds", 6))
            max_wait_seconds = int(payload.get("max_wait_seconds", 720))
            extend_retry_max = int(payload.get("extend_retry_max", 1))
            extend_retry_max = max(0, min(extend_retry_max, 2))
            extend_retry_delay_seconds = int(payload.get("extend_retry_delay_seconds", 2))
            extend_retry_delay_seconds = max(0, min(extend_retry_delay_seconds, 10))

            seeded_payload = dict(payload)
            if seeded_payload.get("seed") is None or str(seeded_payload.get("seed")).strip() == "":
                seeded_payload["seed"] = random.randint(1, 4294967295)

            token = get_access_token(key_file, proxy)
            segments = []

            # Step 1: base 8s generation (supports text/image/reference modes)
            base_payload = dict(seeded_payload)
            base_payload["duration_seconds"] = 8
            veo_mode = (base_payload.get("veo_mode") or "text").strip()
            image_url = (base_payload.get("image_url") or "").strip()
            image_b64 = (base_payload.get("image_base64") or "").strip()
            image_mime_type = (base_payload.get("image_mime_type") or "image/png").strip()
            reference_urls = normalize_reference_urls(base_payload.get("reference_image_urls"))
            reference_images_base64 = normalize_reference_images_base64(base_payload.get("reference_images_base64"))
            reference_type = (base_payload.get("reference_type") or "asset").strip()
            if image_b64.startswith("data:image/"):
                image_b64, image_mime_type = parse_data_url(image_b64)
            if image_mime_type not in {"image/png", "image/jpeg"}:
                return json_error("image_mime_type 仅支持 image/png 或 image/jpeg")

            base_instance = {"prompt": prompt}
            if veo_mode == "image":
                if not image_b64 and not image_url:
                    return json_error("veo_mode=image 时需提供 image_url 或 image_base64")
                if not image_b64 and image_url:
                    image_b64, image_mime_type = fetch_image_as_base64(image_url, proxy)
                base_instance["image"] = {
                    "bytesBase64Encoded": image_b64,
                    "mimeType": image_mime_type,
                }
            elif veo_mode == "reference":
                if not reference_urls and not reference_images_base64:
                    return json_error("veo_mode=reference 时 reference_image_urls 或 reference_images_base64 不能为空")
                refs = []
                for ref in reference_images_base64[:3]:
                    refs.append(
                        {
                            "image": {
                                "bytesBase64Encoded": ref["base64"],
                                "mimeType": ref["mime_type"],
                            },
                            "referenceType": reference_type,
                        }
                    )
                for ref_url in reference_urls[:3]:
                    ref_b64, ref_mime = fetch_image_as_base64(ref_url, proxy)
                    refs.append(
                        {
                            "image": {
                                "bytesBase64Encoded": ref_b64,
                                "mimeType": ref_mime,
                            },
                            "referenceType": reference_type,
                        }
                    )
                base_instance["referenceImages"] = refs

            base_parameters, _, base_effective_duration = _build_common_generation_parameters(
                base_payload, normalize_duration_seconds=normalize_duration_seconds
            )

            async_mode = bool(payload.get("async_mode", False))
            if async_mode:
                from shoplive.backend.async_executor import get_executor
                job_id = f"chain-job-{uuid.uuid4().hex[:12]}"
                with _chain_jobs_lock:
                    _chain_jobs[job_id] = {
                        "job_id": job_id,
                        "status": "running",
                        "progress": 0,
                        "started_at": time.time(),
                        "result": None,
                        "error": None,
                    }
                # Capture all validated state for the background thread
                _captured = dict(
                    project_id=project_id, model=model, token=token, proxy=proxy,
                    key_file=key_file, prompt=prompt, veo_mode=veo_mode,
                    base_instance=base_instance, base_parameters=base_parameters,
                    base_effective_duration=base_effective_duration,
                    seeded_payload=seeded_payload,
                    target_total_seconds=target_total_seconds,
                    extend_rounds=extend_rounds,
                    poll_interval_seconds=poll_interval_seconds,
                    max_wait_seconds=max_wait_seconds,
                    extend_retry_max=extend_retry_max,
                    extend_retry_delay_seconds=extend_retry_delay_seconds,
                )

                def _bg_chain(_jid=job_id, _c=_captured):
                    try:
                        _update_chain_job(_jid, progress=5, message="submitting base generation")
                        _st, _ok, _sdata = _call_predict_long_running(
                            project_id=_c["project_id"], model=_c["model"],
                            token=_c["token"], proxy=_c["proxy"],
                            body={"instances": [_c["base_instance"]], "parameters": _c["base_parameters"]},
                        )
                        if not _ok:
                            _update_chain_job(_jid, status="failed", error=f"base_generate failed: status={_st}")
                            return
                        _base_op = _sdata.get("name")
                        if not _base_op:
                            _update_chain_job(_jid, status="failed", error="base operation_name missing")
                            return
                        _update_chain_job(_jid, progress=15, message="polling base video")
                        _base_uri, _ = _poll_video_ready(
                            project_id=_c["project_id"], model=_c["model"],
                            token=_c["token"], proxy=_c["proxy"],
                            operation_name=_base_op,
                            poll_interval_seconds=_c["poll_interval_seconds"],
                            max_wait_seconds=_c["max_wait_seconds"],
                        )
                        try:
                            _base_signed = sign_gcs_url(_base_uri, _c["key_file"])
                        except Exception as _sign_err:
                            _base_signed = ""
                            audit_log.record(
                                tool="chain_video_segments", action="sign_gcs_url",
                                input_summary={"uri": _base_uri[:80]},
                                output_summary={},
                                status="error", error_code="GCS_SIGN_FAILED",
                                duration_ms=0,
                            )
                        _segments = [{
                            "step": 1, "type": "base_generate",
                            "operation_name": _base_op,
                            "effective_duration_seconds": _c["base_effective_duration"],
                            "video_gcs_uri": _base_uri,
                            "signed_video_url": _base_signed,
                        }]
                        _current_uri = _base_uri
                        for _idx in range(_c["extend_rounds"]):
                            _update_chain_job(_jid, progress=15 + int(70 * (_idx + 1) / max(1, _c["extend_rounds"])),
                                              message=f"extend round {_idx + 1}/{_c['extend_rounds']}")
                            _ep = (
                                (_c["seeded_payload"].get("extend_prompt") or "").strip()
                                or (
                                    f"{_c['prompt']} Continue seamlessly from previous segment. "
                                    "Keep the same product identity, camera language, lighting, "
                                    "color palette, and motion style. No abrupt scene jump."
                                )
                            )
                            _ext_inst = {"prompt": _ep, "video": {"gcsUri": _current_uri, "mimeType": "video/mp4"}}
                            _ext_payload = dict(_c["seeded_payload"])
                            _ext_payload.pop("duration_seconds", None)
                            _ext_params, _, _ = _build_common_generation_parameters(
                                _ext_payload, normalize_duration_seconds=normalize_duration_seconds
                            )
                            _ext_op = ""
                            _ext_retry_errs = []
                            for _att in range(_c["extend_retry_max"] + 1):
                                _st2, _ok2, _edata = _call_predict_long_running(
                                    project_id=_c["project_id"], model=_c["model"],
                                    token=_c["token"], proxy=_c["proxy"],
                                    body={"instances": [_ext_inst], "parameters": _ext_params},
                                )
                                if not _ok2:
                                    _ext_retry_errs.append(f"att{_att+1}: submit_failed st={_st2}")
                                    if _att < _c["extend_retry_max"]:
                                        time.sleep(_c["extend_retry_delay_seconds"])
                                    continue
                                _ext_op = str(_edata.get("name") or "").strip()
                                if not _ext_op:
                                    _ext_retry_errs.append(f"att{_att+1}: op_name_missing")
                                    if _att < _c["extend_retry_max"]:
                                        time.sleep(_c["extend_retry_delay_seconds"])
                                    continue
                                try:
                                    _current_uri, _ = _poll_video_ready(
                                        project_id=_c["project_id"], model=_c["model"],
                                        token=_c["token"], proxy=_c["proxy"],
                                        operation_name=_ext_op,
                                        poll_interval_seconds=_c["poll_interval_seconds"],
                                        max_wait_seconds=_c["max_wait_seconds"],
                                    )
                                    break
                                except Exception as _pe:
                                    _ext_retry_errs.append(f"att{_att+1}: {_pe}")
                                    if _att < _c["extend_retry_max"]:
                                        time.sleep(_c["extend_retry_delay_seconds"])
                            else:
                                _update_chain_job(_jid, status="failed",
                                                  error=f"extend_{_idx+1} failed: {'; '.join(_ext_retry_errs)}")
                                return
                            try:
                                _ext_signed = sign_gcs_url(_current_uri, _c["key_file"])
                            except Exception:
                                _ext_signed = ""
                            _segments.append({
                                "step": _idx + 2, "type": "extend",
                                "operation_name": _ext_op,
                                "video_gcs_uri": _current_uri,
                                "signed_video_url": _ext_signed,
                            })
                        _result = {
                            "ok": True, "status_code": 200,
                            "model": _c["model"], "mode": "chain_extend",
                            "seed": _c["seeded_payload"].get("seed"),
                            "target_total_seconds": _c["target_total_seconds"],
                            "segment_count": len(_segments),
                            "segments": _segments,
                            "final_video_gcs_uri": _current_uri,
                            "final_signed_video_url": _segments[-1].get("signed_video_url") if _segments else "",
                        }
                        _update_chain_job(_jid, status="done", progress=100, result=_result)
                    except Exception as _exc:
                        _update_chain_job(_jid, status="failed", error=str(_exc)[:400])

                get_executor().submit(_bg_chain)
                return jsonify({"ok": True, "async": True, "job_id": job_id, "status": "running"}), 202

            status_code, ok, submit_data = _call_predict_long_running(
                project_id=project_id,
                model=model,
                token=token,
                proxy=proxy,
                body={"instances": [base_instance], "parameters": base_parameters},
            )
            if not ok:
                audit_log.record(
                    tool="chain_video_segments",
                    action="veo_chain",
                    input_summary={
                        "model": model,
                        "veo_mode": veo_mode,
                        "target_total_seconds": target_total_seconds,
                        "prompt_length": len(prompt),
                    },
                    output_summary={"step": "base_generate", "status_code": status_code},
                    status="error",
                    error_code="VEO_BASE_GENERATE_FAILED",
                    duration_ms=int((time.monotonic() - _t0) * 1000),
                )
                return (
                    jsonify(
                        {
                            "ok": False,
                            "status_code": status_code,
                            "step": "base_generate",
                            "response": submit_data,
                        }
                    ),
                    status_code,
                )
            base_operation_name = submit_data.get("name")
            if not base_operation_name:
                return json_error("Veo base operation_name 缺失", 502)
            base_video_uri, _ = _poll_video_ready(
                project_id=project_id,
                model=model,
                token=token,
                proxy=proxy,
                operation_name=base_operation_name,
                poll_interval_seconds=poll_interval_seconds,
                max_wait_seconds=max_wait_seconds,
            )
            try:
                base_signed_url = sign_gcs_url(base_video_uri, key_file)
            except Exception:
                base_signed_url = ""
            segments.append(
                {
                    "step": 1,
                    "type": "base_generate",
                    "operation_name": base_operation_name,
                    "effective_duration_seconds": base_effective_duration,
                    "video_gcs_uri": base_video_uri,
                    "signed_video_url": base_signed_url,
                }
            )

            # Step 2+: chained extends for 16/24
            current_video_uri = base_video_uri
            for idx in range(extend_rounds):
                source_video_uri = current_video_uri
                extend_prompt = (
                    (seeded_payload.get("extend_prompt") or "").strip()
                    or (
                        f"{prompt} Continue seamlessly from previous segment. "
                        "Keep the same product identity, camera language, lighting, color palette, and motion style. "
                        "No abrupt scene jump."
                    )
                )
                extend_instance = {
                    "prompt": extend_prompt,
                    "video": {
                        "gcsUri": current_video_uri,
                        "mimeType": "video/mp4",
                    },
                }
                extend_payload = dict(seeded_payload)
                extend_payload.pop("duration_seconds", None)
                extend_parameters, _, _ = _build_common_generation_parameters(
                    extend_payload, normalize_duration_seconds=normalize_duration_seconds
                )
                extend_operation_name = ""
                attempt_count = 0
                retry_errors = []
                last_submit_data = {}
                for attempt in range(extend_retry_max + 1):
                    attempt_count = attempt + 1
                    st2, ok2, extend_submit_data = _call_predict_long_running(
                        project_id=project_id,
                        model=model,
                        token=token,
                        proxy=proxy,
                        body={"instances": [extend_instance], "parameters": extend_parameters},
                    )
                    last_submit_data = extend_submit_data
                    if not ok2:
                        retry_errors.append(f"attempt_{attempt_count}: submit_failed status={st2}")
                        if attempt < extend_retry_max:
                            time.sleep(extend_retry_delay_seconds)
                        continue
                    extend_operation_name = str(extend_submit_data.get("name") or "").strip()
                    if not extend_operation_name:
                        retry_errors.append(f"attempt_{attempt_count}: operation_name_missing")
                        if attempt < extend_retry_max:
                            time.sleep(extend_retry_delay_seconds)
                        continue
                    try:
                        current_video_uri, _ = _poll_video_ready(
                            project_id=project_id,
                            model=model,
                            token=token,
                            proxy=proxy,
                            operation_name=extend_operation_name,
                            poll_interval_seconds=poll_interval_seconds,
                            max_wait_seconds=max_wait_seconds,
                        )
                        break
                    except Exception as poll_err:
                        retry_errors.append(f"attempt_{attempt_count}: {poll_err}")
                        if attempt < extend_retry_max:
                            time.sleep(extend_retry_delay_seconds)
                else:
                    audit_log.record(
                        tool="chain_video_segments",
                        action="veo_chain",
                        input_summary={
                            "model": model,
                            "target_total_seconds": target_total_seconds,
                            "prompt_length": len(prompt),
                        },
                        output_summary={
                            "step": f"extend_{idx + 1}",
                            "segments_completed": len(segments),
                        },
                        status="error",
                        error_code="VEO_EXTEND_FAILED",
                        error_message=("; ".join(retry_errors))[:200],
                        duration_ms=int((time.monotonic() - _t0) * 1000),
                    )
                    return (
                        jsonify(
                            {
                                "ok": False,
                                "status_code": 502,
                                "step": f"extend_{idx + 1}",
                                "segments": segments,
                                "retry_errors": retry_errors,
                                "response": last_submit_data,
                            }
                        ),
                        502,
                    )
                try:
                    extend_signed_url = sign_gcs_url(current_video_uri, key_file)
                except Exception:
                    extend_signed_url = ""
                segments.append(
                    {
                        "step": idx + 2,
                        "type": "extend",
                        "operation_name": extend_operation_name,
                        "source_video_gcs_uri": source_video_uri,
                        "video_gcs_uri": current_video_uri,
                        "signed_video_url": extend_signed_url,
                        "attempt_count": attempt_count,
                    }
                )

            _dur_ms = int((time.monotonic() - _t0) * 1000)
            audit_log.record(
                tool="chain_video_segments",
                action="veo_chain",
                input_summary={
                    "model": model,
                    "veo_mode": veo_mode,
                    "target_total_seconds": target_total_seconds,
                    "prompt_length": len(prompt),
                    "sample_count": sample_count,
                    "extend_rounds": extend_rounds,
                },
                output_summary={
                    "segment_count": len(segments),
                    "final_video_gcs_uri": current_video_uri[:80] if current_video_uri else "",
                },
                status="success",
                duration_ms=_dur_ms,
            )
            return jsonify(
                {
                    "ok": True,
                    "status_code": 200,
                    "model": model,
                    "mode": "chain_extend",
                    "seed": seeded_payload.get("seed"),
                    "target_total_seconds": target_total_seconds,
                    "segment_count": len(segments),
                    "segments": segments,
                    "final_video_gcs_uri": current_video_uri,
                    "final_signed_video_url": segments[-1].get("signed_video_url") if segments else "",
                    "consistency_strategy": {
                        "reuse_seed": True,
                        "reuse_parameters": ["aspect_ratio", "resolution", "negative_prompt", "person_generation", "seed"],
                        "extend_prompt_anchor": True,
                        "extend_retry_max": extend_retry_max,
                    },
                }
            )
        except ValueError as e:
            audit_log.record(
                tool="chain_video_segments",
                action="veo_chain",
                input_summary={"prompt_length": len(str(payload.get("prompt") or ""))},
                output_summary={},
                status="validation_error",
                error_message=str(e)[:200],
                duration_ms=int((time.monotonic() - _t0) * 1000),
            )
            return json_error(str(e))
        except Exception as e:
            audit_log.record(
                tool="chain_video_segments",
                action="veo_chain",
                input_summary={"prompt_length": len(str(payload.get("prompt") or ""))},
                output_summary={},
                status="error",
                error_code="VEO_CHAIN_FAILED",
                error_message=str(e)[:200],
                duration_ms=int((time.monotonic() - _t0) * 1000),
            )
            return json_error(f"Veo 链式生成失败: {e}", 500)

    @app.get("/api/veo/chain/status")
    def api_veo_chain_status():
        """Poll status of an async /api/veo/chain job.

        Query params:
            job_id: str — returned by POST /api/veo/chain when async_mode=true

        Returns:
            {"job_id", "status": "running"|"done"|"failed", "progress": 0-100,
             "result": {...} (on done), "error": str (on failed)}
        """
        job_id = str(request.args.get("job_id") or "").strip()
        if not job_id:
            return json_error("job_id 不能为空")
        with _chain_jobs_lock:
            job = _chain_jobs.get(job_id)
            if not job:
                return json_error("job 不存在", 404)
            return jsonify({
                "job_id": job["job_id"],
                "status": job["status"],
                "progress": job.get("progress", 0),
                "message": job.get("message", ""),
                "started_at": job.get("started_at"),
                "result": job.get("result"),
                "error": job.get("error"),
            })

    @app.get("/api/veo/chain/stream")
    def api_veo_chain_stream():
        """SSE stream for async chain job progress.

        Query params:
            job_id: str — returned by POST /api/veo/chain when async_mode=true

        Streams ``data: {...}`` events (1s interval) until the job reaches a
        terminal state, then emits ``data: [DONE]`` and closes the connection.
        """
        import json as _json

        job_id = str(request.args.get("job_id") or "").strip()
        if not job_id:
            return json_error("job_id 不能为空")
        with _chain_jobs_lock:
            if job_id not in _chain_jobs:
                return json_error("job 不存在", 404)

        def _generate():
            while True:
                with _chain_jobs_lock:
                    job = _chain_jobs.get(job_id)
                if not job:
                    yield f"data: {_json.dumps({'error': 'job not found'})}\n\n"
                    yield "data: [DONE]\n\n"
                    return
                event = {
                    "job_id": job["job_id"],
                    "status": job["status"],
                    "progress": job.get("progress", 0),
                    "message": job.get("message", ""),
                }
                if job.get("result") is not None:
                    event["result"] = job["result"]
                if job.get("error"):
                    event["error"] = job["error"]
                yield f"data: {_json.dumps(event)}\n\n"
                if job["status"] in {"done", "failed", "cancelled"}:
                    yield "data: [DONE]\n\n"
                    return
                time.sleep(1.0)

        return Response(
            stream_with_context(_generate()),
            mimetype="text/event-stream",
            headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
        )

    @app.post("/api/veo/status")
    @validate_request(VeoStatusRequest)
    def api_veo_status():
        _t0 = time.monotonic()
        payload = g.req.model_dump()
        try:
            project_id, key_file, proxy, model = parse_common_payload(payload)
            operation_name = g.req.operation_name
            if not model:
                model = "veo-3.1-generate-preview"
            if not operation_name:
                return json_error("operation_name 不能为空")

            token = get_access_token(key_file, proxy)
            url = (
                "https://us-central1-aiplatform.googleapis.com/v1/projects/"
                f"{project_id}/locations/us-central1/publishers/google/models/{model}:fetchPredictOperation"
            )
            headers = {
                "Authorization": f"Bearer {token}",
                "Content-Type": "application/json; charset=utf-8",
            }
            body = {"operationName": operation_name}
            _inc_veo_status_metric("total_calls", 1)
            attempt = 0
            max_attempts = 3
            retry_delays = [0.6, 1.2]
            transient_events = 0
            had_retry = False
            last_exc = None
            resp = None
            try:
                while attempt < max_attempts:
                    attempt += 1
                    try:
                        candidate = requests.post(
                            url,
                            headers=headers,
                            json=body,
                            timeout=(10, 25),
                            proxies=build_proxies(proxy),
                        )
                        if candidate.status_code in {429, 500, 502, 503, 504} and attempt < max_attempts:
                            transient_events += 1
                            had_retry = True
                            last_exc = RuntimeError(f"upstream status={candidate.status_code}")
                            time.sleep(retry_delays[min(attempt - 1, len(retry_delays) - 1)])
                            continue
                        resp = candidate
                        break
                    except (requests.exceptions.Timeout, requests.exceptions.ConnectionError) as e:
                        transient_events += 1
                        had_retry = True
                        last_exc = e
                        if attempt >= max_attempts:
                            break
                        time.sleep(retry_delays[min(attempt - 1, len(retry_delays) - 1)])

                if resp is None:
                    raise last_exc or requests.exceptions.Timeout("fetchPredictOperation timeout")
            except (requests.exceptions.Timeout, requests.exceptions.ConnectionError):
                _inc_veo_status_metric("transient_events", max(1, transient_events))
                if had_retry:
                    _inc_veo_status_metric("retried_calls", 1)
                    _inc_veo_status_metric("retry_attempts_total", max(0, attempt - 1))
                _inc_veo_status_metric("retry_exhausted", 1)
                _dur_ms = int((time.monotonic() - _t0) * 1000)
                audit_log.record(
                    tool="check_video_status",
                    action="veo_status",
                    input_summary={
                        "model": model,
                        "operation_name": operation_name[:80],
                    },
                    output_summary={
                        "ok": False,
                        "status_code": 504,
                        "done": False,
                        "video_count": 0,
                        "inline_video_count": 0,
                        "transient": True,
                        "retry_attempts": max(0, attempt - 1),
                    },
                    status="error",
                    error_code="VEO_STATUS_UPSTREAM_TIMEOUT",
                    duration_ms=_dur_ms,
                )
                return jsonify(
                    {
                        "ok": False,
                        "status_code": 504,
                        "model": model,
                        "video_uris": [],
                        "signed_all_urls": [],
                        "signed_video_urls": [],
                        "inline_videos": [],
                        "transient": True,
                        "retry_attempts": max(0, attempt - 1),
                        "response": {
                            "done": False,
                            "error": {
                                "message": "fetchPredictOperation timeout; please poll again",
                            },
                        },
                    }
                ), 200
            data = resp.json() if resp.headers.get("content-type", "").find("json") >= 0 else {"raw": resp.text}
            if transient_events:
                _inc_veo_status_metric("transient_events", transient_events)
            if had_retry:
                _inc_veo_status_metric("retried_calls", 1)
                _inc_veo_status_metric("retry_attempts_total", max(0, attempt - 1))
            gs_paths = extract_gs_paths(data)
            video_exts = (".mp4", ".mov", ".webm", ".m4v")
            video_uris = [x for x in gs_paths if x.lower().endswith(video_exts)]
            inline_videos = extract_inline_videos(data)
            signed_video_urls = []
            signed_all_urls = []
            for uri in gs_paths:
                try:
                    signed_all_urls.append({"gs_uri": uri, "url": sign_gcs_url(uri, key_file)})
                except Exception as _sign_err:
                    signed_all_urls.append({"gs_uri": uri, "url": "", "sign_error": str(_sign_err)[:200]})
            for uri in video_uris:
                try:
                    signed_video_urls.append({"gs_uri": uri, "url": sign_gcs_url(uri, key_file)})
                except Exception as _sign_err:
                    signed_video_urls.append({"gs_uri": uri, "url": "", "sign_error": str(_sign_err)[:200]})
            _dur_ms = int((time.monotonic() - _t0) * 1000)
            is_done = bool(data.get("done"))
            audit_log.record(
                tool="check_video_status",
                action="veo_status",
                input_summary={
                    "model": model,
                    "operation_name": operation_name[:80],
                },
                output_summary={
                    "ok": resp.ok,
                    "status_code": resp.status_code,
                    "done": is_done,
                    "video_count": len(video_uris),
                    "inline_video_count": len(inline_videos),
                    "retry_attempts": max(0, attempt - 1),
                },
                status="success" if resp.ok else "error",
                error_code=None if resp.ok else "VEO_STATUS_ERROR",
                duration_ms=_dur_ms,
            )
            return jsonify(
                {
                    "ok": resp.ok,
                    "status_code": resp.status_code,
                    "model": model,
                    "video_uris": video_uris,
                    "signed_all_urls": signed_all_urls,
                    "signed_video_urls": signed_video_urls,
                    "inline_videos": inline_videos,
                    "retry_attempts": max(0, attempt - 1),
                    "transient": bool(transient_events),
                    "response": data,
                }
            ), resp.status_code
        except ValueError as e:
            audit_log.record(
                tool="check_video_status",
                action="veo_status",
                input_summary={"operation_name": str(payload.get("operation_name") or "")[:80]},
                output_summary={},
                status="validation_error",
                error_message=str(e)[:200],
                duration_ms=int((time.monotonic() - _t0) * 1000),
            )
            return json_error(str(e))
        except Exception as e:
            audit_log.record(
                tool="check_video_status",
                action="veo_status",
                input_summary={"operation_name": str(payload.get("operation_name") or "")[:80]},
                output_summary={},
                status="error",
                error_code="VEO_STATUS_FAILED",
                error_message=str(e)[:200],
                duration_ms=int((time.monotonic() - _t0) * 1000),
            )
            return json_error(f"Veo 状态查询失败: {e}", 500)

    @app.route("/api/veo/play", methods=["GET", "HEAD"])
    def api_veo_play():
        try:
            gcs_uri = str(request.args.get("gcs_uri") or "").strip()
            if not gcs_uri:
                return json_error("gcs_uri 不能为空")
            if not gcs_uri.startswith("gs://"):
                return json_error("gcs_uri 必须是 gs:// 开头")
            key_hint = str(request.args.get("key_file") or "").strip()
            payload = {
                "project_id": "qy-shoplazza-02",
                "key_file": key_hint,
                "proxy": "",
                "model": "",
            }
            project_id, key_file, _, _ = parse_common_payload(payload)
            m = re.match(r"^gs:\/\/([^\/]+)\/(.+)$", gcs_uri)
            if not m:
                return json_error("gcs_uri 格式错误")
            bucket_name, blob_name = m.group(1), m.group(2)
            from shoplive.backend.common.helpers import _get_gcs_client
            client = _get_gcs_client(key_file)
            blob = client.bucket(bucket_name).blob(blob_name)
            blob.reload()
            total_size = int(blob.size or 0)
            content_type = str(blob.content_type or "video/mp4")
            base_headers = {"Accept-Ranges": "bytes", "Content-Type": content_type}

            if request.method.upper() == "HEAD":
                if total_size > 0:
                    base_headers["Content-Length"] = str(total_size)
                return Response(status=200, headers=base_headers)

            range_header = str(request.headers.get("Range") or "").strip()
            if not range_header:
                data = blob.download_as_bytes()
                headers = dict(base_headers)
                headers["Content-Length"] = str(len(data))
                return Response(data, status=200, headers=headers)

            m_range = re.match(r"^bytes=(\d*)-(\d*)$", range_header)
            if not m_range:
                return Response(status=416, headers=base_headers)
            start_raw, end_raw = m_range.group(1), m_range.group(2)
            if start_raw == "" and end_raw == "":
                return Response(status=416, headers=base_headers)

            if start_raw == "":
                # suffix bytes: bytes=-N
                suffix = int(end_raw)
                if total_size <= 0 or suffix <= 0:
                    return Response(status=416, headers=base_headers)
                start = max(0, total_size - suffix)
                end = total_size - 1
            else:
                start = int(start_raw)
                end = int(end_raw) if end_raw != "" else max(0, total_size - 1)

            if total_size > 0:
                end = min(end, total_size - 1)
            if start < 0 or end < start:
                return Response(status=416, headers=base_headers)

            data = blob.download_as_bytes(start=start, end=end)
            headers = dict(base_headers)
            headers["Content-Length"] = str(len(data))
            if total_size > 0:
                headers["Content-Range"] = f"bytes {start}-{end}/{total_size}"
            return Response(data, status=206, headers=headers)
        except ValueError as e:
            return json_error(str(e))
        except Exception as e:
            return json_error(f"Veo 播放地址生成失败: {e}", 500)

    def _download_http_video_to_file(url: str, output_path: Path, *, timeout: int = 60) -> None:
        """Download a plain http(s) video URL to a local file."""
        import requests as _requests
        resp = _requests.get(url, timeout=timeout, stream=True)
        if not resp.ok:
            raise ValueError(f"HTTP 视频下载失败 status={resp.status_code}: {url}")
        ct = resp.headers.get("content-type", "").lower()
        if ct and not any(x in ct for x in ("video", "octet-stream")):
            raise ValueError(f"HTTP 视频下载类型不符 content-type={ct}: {url}")
        with output_path.open("wb") as f:
            for chunk in resp.iter_content(chunk_size=1 << 20):
                if chunk:
                    f.write(chunk)
        size = output_path.stat().st_size if output_path.exists() else 0
        if size < 1024:
            raise ValueError(f"HTTP 视频下载后体积过小 ({size} bytes): {url}")

    @app.post("/api/veo/mitigate-output")
    def api_veo_mitigate_output():
        """Single-segment Veo output: download (GCS / HTTP / data URL) → flicker mitigate → /video-edits/."""
        _t0 = time.monotonic()
        payload = request.get_json(silent=True) or {}
        try:
            project_id, key_file, proxy, _ = parse_common_payload(payload)
            gcs_uri = (payload.get("gcs_uri") or "").strip()
            http_url = (payload.get("video_http_url") or "").strip()
            data_url = (payload.get("video_data_url") or "").strip()
            if not gcs_uri and not http_url and not data_url:
                return json_error("需要 gcs_uri、video_http_url 或 video_data_url 之一")
            if not video_export_dir:
                return json_error("video export 未配置", 500)
            if gcs_uri and not download_gcs_blob_to_file:
                return json_error("GCS 下载未配置", 500)

            tmp_dir = Path(tempfile.mkdtemp(prefix="veo_mit_"))
            try:
                src = tmp_dir / "src.mp4"
                if gcs_uri:
                    if not gcs_uri.startswith("gs://"):
                        return json_error("gcs_uri 格式错误")
                    download_gcs_blob_to_file(gcs_uri, src, key_file, project_id)
                elif http_url:
                    _download_http_video_to_file(http_url, src, timeout=180)
                else:
                    _write_video_data_url_to_file(data_url, src)
                mitigated = tmp_dir / "mitigated.mp4"
                try:
                    mitigate_veo_temporal_flicker(src, mitigated)
                    final_path = mitigated
                except Exception as _mit_e:
                    logger.warning("mitigate-output flicker filter skipped: %s", _mit_e)
                    final_path = src
                final_data = final_path.read_bytes()
            finally:
                shutil.rmtree(tmp_dir, ignore_errors=True)

            out_name = f"veo-mit-{uuid.uuid4().hex[:12]}.mp4"
            out_file = video_export_dir / out_name
            out_file.write_bytes(final_data)
            _dur_ms = int((time.monotonic() - _t0) * 1000)
            audit_log.record(
                tool="veo_mitigate_output",
                action="ffmpeg_mitigate",
                input_summary={
                    "has_gcs": bool(gcs_uri),
                    "has_http": bool(http_url),
                    "has_data": bool(data_url),
                },
                output_summary={"size_bytes": len(final_data)},
                status="success",
                duration_ms=_dur_ms,
            )
            return jsonify({"ok": True, "video_url": f"/video-edits/{out_name}"})
        except ValueError as e:
            return json_error(str(e))
        except Exception as e:
            logger.exception("mitigate-output failed")
            return json_error(f"mitigate-output 失败: {e}", 500)

    @app.post("/api/veo/concat-segments")
    def api_veo_concat_segments():
        """Concatenate two video segments from GCS, inline data URLs, or plain HTTP URLs."""
        _t0 = time.monotonic()
        payload = request.get_json(silent=True) or {}
        try:
            project_id, key_file, proxy, _ = parse_common_payload(payload)
            gcs_uri_a  = (payload.get("gcs_uri_a")        or "").strip()
            gcs_uri_b  = (payload.get("gcs_uri_b")        or "").strip()
            data_url_a = (payload.get("video_data_url_a") or "").strip()
            data_url_b = (payload.get("video_data_url_b") or "").strip()
            http_url_a = (payload.get("video_http_url_a") or "").strip()
            http_url_b = (payload.get("video_http_url_b") or "").strip()
            has_a = bool(gcs_uri_a or data_url_a or http_url_a)
            has_b = bool(gcs_uri_b or data_url_b or http_url_b)
            if not has_a or not has_b:
                return json_error("Each segment requires gcs_uri_x, video_data_url_x, or video_http_url_x")
            if not concat_videos_ffmpeg or not download_gcs_blob_to_file:
                return json_error("concat helpers not configured", 500)

            import shutil
            import base64 as b64mod
            tmp_dir = Path(tempfile.mkdtemp(prefix="veo_concat_"))
            try:
                seg_a_path = tmp_dir / "seg_a.mp4"
                seg_b_path = tmp_dir / "seg_b.mp4"
                if gcs_uri_a:
                    download_gcs_blob_to_file(gcs_uri_a, seg_a_path, key_file, project_id)
                elif http_url_a:
                    _download_http_video_to_file(http_url_a, seg_a_path)
                else:
                    _write_video_data_url_to_file(data_url_a, seg_a_path)
                if gcs_uri_b:
                    download_gcs_blob_to_file(gcs_uri_b, seg_b_path, key_file, project_id)
                elif http_url_b:
                    _download_http_video_to_file(http_url_b, seg_b_path)
                else:
                    _write_video_data_url_to_file(data_url_b, seg_b_path)
                concat_path = tmp_dir / "concat_out.mp4"
                concat_videos_ffmpeg([seg_a_path, seg_b_path], concat_path)
                final_concat = concat_path
                try:
                    mitigated = tmp_dir / "concat_mitigated.mp4"
                    mitigate_veo_temporal_flicker(concat_path, mitigated)
                    final_concat = mitigated
                except Exception as _mit_e:
                    logger.warning("concat flicker mitigate skipped: %s", _mit_e)
                duration_probe = subprocess.run(
                    [
                        "ffprobe", "-v", "error",
                        "-show_entries", "format=duration",
                        "-of", "default=noprint_wrappers=1:nokey=1",
                        str(final_concat),
                    ],
                    stdout=subprocess.PIPE,
                    stderr=subprocess.PIPE,
                    text=True,
                )
                try:
                    concat_duration_seconds = float((duration_probe.stdout or "").strip() or 0.0)
                except Exception:
                    concat_duration_seconds = 0.0
                final_data = final_concat.read_bytes()
            finally:
                shutil.rmtree(tmp_dir, ignore_errors=True)

            # Save to export dir for HTTP access (avoids large base64 in response)
            concat_video_url = ""
            if video_export_dir:
                try:
                    import uuid as _uuid
                    out_name = f"concat-{_uuid.uuid4().hex}.mp4"
                    out_file = video_export_dir / out_name
                    out_file.write_bytes(final_data)
                    # Use a relative path so the browser resolves it against the
                    # page origin. request.host_url can return http://0.0.0.0:…
                    # when Flask is bound to 0.0.0.0, which browsers cannot load.
                    concat_video_url = f"/video-edits/{out_name}"
                except Exception:
                    pass

            video_b64 = b64mod.b64encode(final_data).decode("utf-8")
            data_url = f"data:video/mp4;base64,{video_b64}"
            _dur_ms = int((time.monotonic() - _t0) * 1000)
            audit_log.record(
                tool="concat_video_segments",
                action="ffmpeg_concat",
                input_summary={
                    "gcs_a": gcs_uri_a[-40:] if gcs_uri_a else "",
                    "gcs_b": gcs_uri_b[-40:] if gcs_uri_b else "",
                    "use_data_url_a": bool(data_url_a and not gcs_uri_a),
                    "use_data_url_b": bool(data_url_b and not gcs_uri_b),
                    "use_http_url_a": bool(http_url_a),
                    "use_http_url_b": bool(http_url_b),
                },
                output_summary={"concat_size_bytes": len(final_data), "has_video_url": bool(concat_video_url)},
                status="success",
                duration_ms=_dur_ms,
            )
            resp_body = {
                "ok": True,
                "video_data_url": data_url,
                "duration_seconds": round(concat_duration_seconds, 3),
            }
            if concat_video_url:
                resp_body["video_url"] = concat_video_url
            return jsonify(resp_body)
        except ValueError as e:
            return json_error(str(e))
        except Exception as e:
            return json_error(f"视频拼接失败: {e}", 500)

    @app.post("/api/veo/extract-frame")
    def api_veo_extract_frame():
        """Extract a single frame from a GCS or inline data-url video using ffmpeg."""
        payload = request.get_json(silent=True) or {}
        try:
            project_id, key_file, proxy, _ = parse_common_payload(payload)
            gcs_uri = (payload.get("gcs_uri") or "").strip()
            video_data_url = (payload.get("video_data_url") or "").strip()
            position = (payload.get("position") or "last").strip()
            if not gcs_uri and not video_data_url:
                return json_error("gcs_uri or video_data_url is required")
            if not download_gcs_blob_to_file:
                return json_error("extract-frame helpers not configured", 500)

            import shutil
            import subprocess
            import base64 as b64mod
            tmp_dir = Path(tempfile.mkdtemp(prefix="veo_frame_"))
            try:
                video_path = tmp_dir / "input.mp4"
                if gcs_uri:
                    download_gcs_blob_to_file(gcs_uri, video_path, key_file, project_id)
                else:
                    _write_video_data_url_to_file(video_data_url, video_path)

                if not video_path.exists() or video_path.stat().st_size < 1024:
                    raise ValueError("Downloaded video is empty or too small")

                if position == "last":
                    # Use -sseof with fallback: if it fails (no duration metadata),
                    # fall back to extracting the first frame instead.
                    cmd = [
                        "ffmpeg", "-sseof", "-0.15",
                        "-i", str(video_path),
                        "-frames:v", "1",
                        "-f", "image2pipe",
                        "-vcodec", "png",
                        "pipe:1",
                    ]
                elif position == "first":
                    cmd = [
                        "ffmpeg",
                        "-i", str(video_path),
                        "-frames:v", "1",
                        "-f", "image2pipe",
                        "-vcodec", "png",
                        "pipe:1",
                    ]
                else:
                    sec = float(position)
                    cmd = [
                        "ffmpeg", "-ss", str(sec),
                        "-i", str(video_path),
                        "-frames:v", "1",
                        "-f", "image2pipe",
                        "-vcodec", "png",
                        "pipe:1",
                    ]
                proc = subprocess.run(
                    cmd,
                    stdout=subprocess.PIPE,
                    stderr=subprocess.PIPE,
                    timeout=30,
                )
                if (proc.returncode != 0 or not proc.stdout) and position == "last":
                    fallback_cmd = [
                        "ffmpeg",
                        "-i", str(video_path),
                        "-frames:v", "1",
                        "-f", "image2pipe",
                        "-vcodec", "png",
                        "pipe:1",
                    ]
                    proc = subprocess.run(
                        fallback_cmd,
                        stdout=subprocess.PIPE,
                        stderr=subprocess.PIPE,
                        timeout=30,
                    )
                if proc.returncode != 0 or not proc.stdout:
                    stderr_tail = (proc.stderr or b"").decode("utf-8", errors="replace")[-300:]
                    raise RuntimeError(f"ffmpeg extract failed: {stderr_tail}")

                frame_b64 = b64mod.b64encode(proc.stdout).decode("utf-8")
                return jsonify({
                    "ok": True,
                    "frame_base64": frame_b64,
                    "mime_type": "image/png",
                    "position": position,
                })
            finally:
                shutil.rmtree(tmp_dir, ignore_errors=True)
        except ValueError as e:
            return json_error(str(e))
        except Exception as e:
            return json_error(f"帧提取失败: {e}", 500)

    def _api_generate_split_video(segment_seconds: int):
        """Shared implementation for /api/veo/generate-16s and /api/veo/generate-12s.

        Splits the prompt with LLM, generates both segments in parallel, downloads and
        concatenates with ffmpeg, then saves the result to video_export_dir.
        Returns video_url (HTTP) + video_data_url (base64) for backward compatibility.
        """
        import os, shutil, uuid as _uuid, base64 as b64mod
        total_seconds = segment_seconds * 2
        _t0 = time.monotonic()
        payload = request.get_json(silent=True) or {}
        tool_name = f"generate_video_{total_seconds}s"
        action_name = f"veo_{total_seconds}s"
        try:
            project_id, key_file, proxy, model = parse_common_payload(payload)
            prompt = (payload.get("prompt") or "").strip()
            if not model:
                model = "veo-3.1-generate-preview"
            if not prompt:
                return json_error("prompt 不能为空", error_code="MISSING_PROMPT")

            api_base = (
                payload.get("api_base")
                or os.getenv("LITELLM_API_BASE")
                or "https://litellm.shoplazza.site"
            ).strip().rstrip("/")
            api_key = (payload.get("api_key") or os.getenv("LITELLM_API_KEY") or "").strip()
            llm_model = (payload.get("llm_model") or "bedrock-claude-4-5-haiku").strip()

            split_fn = split_prompt_for_16s if segment_seconds == 8 else split_prompt_for_12s
            if not split_fn or not concat_videos_ffmpeg or not download_gcs_blob_to_file:
                return json_error(f"{total_seconds}s generation helpers not configured", 500)

            # Run LLM prompt-split and GCP token fetch concurrently — they are fully
            # independent and each takes 1-3 s, so overlapping saves ~2-4 s total.
            _prep_pool = get_executor()
            _split_fut = _prep_pool.submit(
                split_fn, prompt,
                api_base=api_base, api_key=api_key, model=llm_model, proxy=proxy,
            )
            _token_fut = _prep_pool.submit(get_access_token, key_file, proxy)
            parts = _split_fut.result()
            token = _token_fut.result()
            prompt_a = _ensure_opening_exposure_stability(parts["part1"])
            prompt_b = _ensure_opening_exposure_stability(parts["part2"])
            aspect_ratio = (payload.get("aspect_ratio") or "16:9").strip()
            storage_uri = (payload.get("storage_uri") or "").strip() or None
            image_b64 = (payload.get("image_base64") or "").strip()
            image_mime_type = (payload.get("image_mime_type") or "image/png").strip()
            image_url = (payload.get("image_url") or "").strip()
            veo_mode = (payload.get("veo_mode") or "text").strip()
            reference_urls = normalize_reference_urls(payload.get("reference_image_urls"))
            reference_images_base64 = normalize_reference_images_base64(payload.get("reference_images_base64"))
            reference_type = (payload.get("reference_type") or "asset").strip()
            if image_b64 and image_b64.startswith("data:image/"):
                image_b64, image_mime_type = parse_data_url(image_b64)

            def _build_instance(seg_prompt):
                inst = {"prompt": seg_prompt}
                if veo_mode == "image":
                    if not image_b64 and image_url:
                        ib, im = fetch_image_as_base64(image_url, proxy)
                        inst["image"] = {"bytesBase64Encoded": ib, "mimeType": im}
                    elif image_b64:
                        inst["image"] = {"bytesBase64Encoded": image_b64, "mimeType": image_mime_type}
                elif veo_mode == "reference":
                    refs = []
                    for ref in reference_images_base64[:3]:
                        refs.append({
                            "image": {
                                "bytesBase64Encoded": ref["base64"],
                                "mimeType": ref["mime_type"],
                            },
                            "referenceType": reference_type,
                        })
                    for ref_url in reference_urls[:3]:
                        ref_b64, ref_mime = fetch_image_as_base64(ref_url, proxy)
                        refs.append({
                            "image": {
                                "bytesBase64Encoded": ref_b64,
                                "mimeType": ref_mime,
                            },
                            "referenceType": reference_type,
                        })
                    if refs:
                        inst["referenceImages"] = refs
                return inst

            base_params: dict = {"sampleCount": 1, "durationSeconds": segment_seconds, "aspectRatio": aspect_ratio}
            if storage_uri:
                base_params["storageUri"] = storage_uri

            def _submit_and_poll(seg_prompt, seg_label):
                body = {"instances": [_build_instance(seg_prompt)], "parameters": dict(base_params)}
                sc, ok, submit_data = _call_predict_long_running(
                    project_id=project_id, model=model, token=token, proxy=proxy, body=body,
                )
                if not ok:
                    raise RuntimeError(f"Segment {seg_label} submit failed (status={sc})")
                op = submit_data.get("name")
                if not op:
                    raise RuntimeError(f"Segment {seg_label} operation_name missing")
                uri, _ = _poll_video_ready(
                    project_id=project_id, model=model, token=token, proxy=proxy,
                    operation_name=op, poll_interval_seconds=6, max_wait_seconds=720,
                )
                try:
                    signed = sign_gcs_url(uri, key_file)
                except Exception:
                    signed = ""
                return {"label": seg_label, "gcs_uri": uri, "signed_url": signed, "operation_name": op}

            from shoplive.backend.async_executor import get_executor
            _pool = get_executor()
            futures = {
                _pool.submit(_submit_and_poll, prompt_a, "A"): "A",
                _pool.submit(_submit_and_poll, prompt_b, "B"): "B",
            }
            segments: list = []
            errors: list = []
            for future in as_completed(futures, timeout=1500):
                label = futures[future]
                try:
                    segments.append(future.result())
                except Exception as e:
                    errors.append({"label": label, "error": str(e)})

            if errors:
                failed = ", ".join(e["label"] for e in errors)
                _dur_ms = int((time.monotonic() - _t0) * 1000)
                # Partial success: at least one segment succeeded → return it instead of 502
                if segments:
                    ok_labels = ", ".join(s["label"] for s in segments)
                    partial_tmp = Path(tempfile.mkdtemp(prefix=f"veo{total_seconds}s_partial_"))
                    try:
                        seg0 = segments[0]
                        lp = partial_tmp / f"seg_{seg0['label']}.mp4"
                        download_gcs_blob_to_file(seg0["gcs_uri"], lp, key_file, project_id)
                        partial_data = lp.read_bytes()
                    finally:
                        shutil.rmtree(partial_tmp, ignore_errors=True)
                    partial_video_url = ""
                    if video_export_dir:
                        try:
                            out_name = f"split-{total_seconds}s-partial-{_uuid.uuid4().hex}.mp4"
                            out_file = video_export_dir / out_name
                            out_file.write_bytes(partial_data)
                            partial_video_url = f"/video-edits/{out_name}"
                        except Exception:
                            pass
                    audit_log.record(
                        tool=tool_name, action=action_name,
                        input_summary={"prompt_length": len(prompt), "model": model},
                        output_summary={"errors": errors, "segments_ok": len(segments),
                                        "partial": True, "has_video_url": bool(partial_video_url)},
                        status="error", error_code=f"VEO_{total_seconds}S_PARTIAL",
                        error_message=f"segments {failed} failed; returned partial from {ok_labels}",
                        duration_ms=_dur_ms,
                    )
                    partial_result = {
                        "ok": True,
                        "partial": True,
                        "status_code": 206,
                        "warning": f"Segment(s) {failed} failed; returning partial video from segment(s) {ok_labels}",
                        "errors": errors,
                        "model": model,
                        "mode": f"prompt_split_{total_seconds}s_partial",
                        "final_duration_seconds": segment_seconds,
                        "segments": [{"label": s["label"], "gcs_uri": s["gcs_uri"],
                                      "signed_url": s["signed_url"]} for s in segments],
                        "prompt_parts": {"part1": prompt_a, "part2": prompt_b},
                        "video_data_url": f"data:video/mp4;base64,{b64mod.b64encode(partial_data).decode()}",
                    }
                    if partial_video_url:
                        partial_result["video_url"] = partial_video_url
                    return jsonify(partial_result), 206
                # All segments failed
                audit_log.record(
                    tool=tool_name, action=action_name,
                    input_summary={"prompt_length": len(prompt), "model": model},
                    output_summary={"errors": errors, "segments_ok": 0},
                    status="error", error_code=f"VEO_{total_seconds}S_SEGMENT_FAILED", duration_ms=_dur_ms,
                )
                return jsonify({
                    "ok": False, "status_code": 502,
                    "error": f"Segment(s) {failed} failed",
                    "errors": errors, "segments": [],
                    "prompt_parts": {"part1": prompt_a, "part2": prompt_b},
                }), 502

            segments.sort(key=lambda s: s["label"])

            tmp_dir = Path(tempfile.mkdtemp(prefix=f"veo{total_seconds}s_"))
            try:
                # Download A and B from GCS in parallel — each is ~1-3 s of network I/O
                def _dl(seg):
                    lp = tmp_dir / f"seg_{seg['label']}.mp4"
                    download_gcs_blob_to_file(seg["gcs_uri"], lp, key_file, project_id)
                    return seg["label"], lp

                _dl_pool = get_executor()
                _dl_futs = {_dl_pool.submit(_dl, seg): seg["label"] for seg in segments}
                _lp_map: dict = {}
                for _df in as_completed(_dl_futs, timeout=600):
                    _lbl, _lp = _df.result()
                    _lp_map[_lbl] = _lp
                # Reassemble in sorted label order (A before B) for correct concat
                local_files = [_lp_map[seg["label"]] for seg in segments]
                concat_path = tmp_dir / f"concat_{total_seconds}s.mp4"
                concat_videos_ffmpeg(local_files, concat_path)
                final_path = concat_path
                try:
                    mitigated = tmp_dir / f"concat_{total_seconds}s_mitigated.mp4"
                    mitigate_veo_temporal_flicker(concat_path, mitigated)
                    final_path = mitigated
                except Exception as _mit_e:
                    logger.warning("split concat flicker mitigate skipped: %s", _mit_e)
                final_data = final_path.read_bytes()
            finally:
                shutil.rmtree(tmp_dir, ignore_errors=True)

            # Save to export dir → return HTTP URL (avoid giant base64 in JSON)
            video_url = ""
            if video_export_dir:
                try:
                    out_name = f"split-{total_seconds}s-{_uuid.uuid4().hex}.mp4"
                    out_file = video_export_dir / out_name
                    out_file.write_bytes(final_data)
                    video_url = f"/video-edits/{out_name}"
                except Exception:
                    pass

            _dur_ms = int((time.monotonic() - _t0) * 1000)
            audit_log.record(
                tool=tool_name, action=action_name,
                input_summary={"prompt_length": len(prompt), "model": model},
                output_summary={"segment_count": len(segments), "concat_size_bytes": len(final_data),
                                "has_video_url": bool(video_url)},
                status="success", duration_ms=_dur_ms,
            )

            video_b64 = b64mod.b64encode(final_data).decode("utf-8")
            result = {
                "ok": True, "status_code": 200, "model": model,
                "mode": f"prompt_split_{total_seconds}s",
                "final_duration_seconds": total_seconds,
                "segments": [{"label": s["label"], "gcs_uri": s["gcs_uri"], "signed_url": s["signed_url"]} for s in segments],
                "prompt_parts": {"part1": prompt_a, "part2": prompt_b},
                "video_data_url": f"data:video/mp4;base64,{video_b64}",
            }
            if video_url:
                result["video_url"] = video_url
            return jsonify(result)

        except ValueError as e:
            return json_error(str(e))
        except Exception as e:
            _dur_ms = int((time.monotonic() - _t0) * 1000)
            audit_log.record(
                tool=tool_name, action=action_name,
                input_summary={"prompt_length": len(str(payload.get("prompt") or ""))},
                output_summary={}, status="error",
                error_code=f"VEO_{total_seconds}S_FAILED", error_message=str(e)[:200], duration_ms=_dur_ms,
            )
            return json_error(f"{total_seconds}s 视频生成失败: {e}", 500)

    @app.post("/api/veo/generate-16s")
    def api_veo_generate_16s():
        """Generate a 16s video: LLM splits prompt → 2×8s parallel generation → ffmpeg concat."""
        return _api_generate_split_video(segment_seconds=8)

    @app.post("/api/veo/generate-12s")
    def api_veo_generate_12s():
        """Generate a 12s video: LLM splits prompt → 2×6s parallel generation → ffmpeg concat.
        Designed for models like Grok that support 6s per generation."""
        return _api_generate_split_video(segment_seconds=6)

    # ------------------------------------------------------------------
    # POST /api/veo/local-chain
    # 本地续写链：segment1 → 提取末帧 → segment2(首帧=末帧) → crossfade 拼接
    # 不需要 GCS，视觉连续性远优于并行硬切
    # ------------------------------------------------------------------
    def _poll_inline_video(
        *,
        project_id: str,
        model: str,
        token: str,
        proxy: str,
        operation_name: str,
        poll_interval_seconds: int = 8,   # kept for call-site compatibility
        max_wait_seconds: int = 720,
        initial_wait_seconds: int = 12,   # lowered from 30 s — same model, same SLA as GCS path
    ) -> Tuple[bytes, Dict]:
        """Poll until video is ready, return (mp4_bytes, raw_data).

        Works for inline-video responses (no storage_uri needed).
        Uses the same adaptive polling schedule as _poll_video_ready.
        """
        started = time.time()
        if initial_wait_seconds > 0:
            time.sleep(min(initial_wait_seconds, max_wait_seconds))
        poll_count = 0
        while time.time() - started <= max_wait_seconds:
            _, _, op_data = _call_fetch_predict_operation(
                project_id=project_id, model=model, token=token,
                proxy=proxy, operation_name=operation_name,
            )
            # Check inline videos first (returns list of dicts with "base64" key)
            inline = extract_inline_videos(op_data)
            if inline:
                raw = base64.b64decode(inline[0]["base64"])
                return raw, op_data
            # Check GCS URIs
            uris = _extract_video_uris(op_data)
            if uris:
                # Download from GCS
                tmp = Path(tempfile.mktemp(suffix=".mp4"))
                try:
                    download_gcs_blob_to_file(uris[0], tmp, "", project_id)
                    return tmp.read_bytes(), op_data
                finally:
                    tmp.unlink(missing_ok=True)
            # Check error
            err = (op_data.get("error", {}).get("message")
                   or op_data.get("response", {}).get("error", {}).get("message") or "")
            if op_data.get("done") and err:
                raise RuntimeError(f"Veo generation failed: {err}")
            interval = float(_POLL_ADAPTIVE[min(poll_count, len(_POLL_ADAPTIVE) - 1)])
            poll_count += 1
            time.sleep(interval)
        raise TimeoutError(f"Veo poll timeout (>{max_wait_seconds}s)")

    def _extract_last_frame(mp4_bytes: bytes) -> Tuple[str, str]:
        """Extract last frame from MP4 bytes, return (base64, mime_type)."""
        tmp_video = Path(tempfile.mktemp(suffix=".mp4"))
        tmp_frame = Path(tempfile.mktemp(suffix=".png"))
        try:
            tmp_video.write_bytes(mp4_bytes)
            # Get duration
            probe = subprocess.run(
                ["ffprobe", "-v", "error", "-show_entries", "format=duration",
                 "-of", "csv=p=0", str(tmp_video)],
                capture_output=True, text=True, timeout=10,
            )
            dur = float(probe.stdout.strip() or "0")
            if dur <= 0:
                raise ValueError("Cannot probe video duration")
            # Seek to last frame
            seek_to = max(0, dur - 0.05)
            subprocess.run(
                ["ffmpeg", "-y", "-ss", f"{seek_to:.3f}", "-i", str(tmp_video),
                 "-frames:v", "1", "-q:v", "2", str(tmp_frame)],
                capture_output=True, timeout=15, check=True,
            )
            frame_bytes = tmp_frame.read_bytes()
            b64 = base64.b64encode(frame_bytes).decode()
            return b64, "image/png"
        finally:
            tmp_video.unlink(missing_ok=True)
            tmp_frame.unlink(missing_ok=True)

    def _crossfade_concat(seg1_bytes: bytes, seg2_bytes: bytes, crossfade_dur: float = 0.5) -> bytes:
        """Concatenate two MP4 segments with crossfade transition."""
        tmpdir = Path(tempfile.mkdtemp(prefix="veo_localchain_"))
        try:
            p1 = tmpdir / "seg1.mp4"
            p2 = tmpdir / "seg2.mp4"
            out = tmpdir / "final.mp4"
            p1.write_bytes(seg1_bytes)
            p2.write_bytes(seg2_bytes)

            # Probe seg1 duration for xfade offset
            probe = subprocess.run(
                ["ffprobe", "-v", "error", "-show_entries", "format=duration",
                 "-of", "csv=p=0", str(p1)],
                capture_output=True, text=True, timeout=10,
            )
            dur1 = float(probe.stdout.strip() or "8")
            offset = max(0, dur1 - crossfade_dur)

            # xfade video + acrossfade audio
            cmd = [
                "ffmpeg", "-y", "-i", str(p1), "-i", str(p2),
                "-filter_complex",
                f"[0:v][1:v]xfade=transition=fade:duration={crossfade_dur}:offset={offset}[vout];"
                f"[0:a][1:a]acrossfade=d={crossfade_dur}[aout]",
                "-map", "[vout]", "-map", "[aout]",
                "-c:v", "libx264", "-preset", "fast", "-crf", "20",
                "-c:a", "aac", "-b:a", "128k",
                "-movflags", "+faststart",
                str(out),
            ]
            result = subprocess.run(cmd, capture_output=True, text=True, timeout=120)
            if result.returncode != 0:
                # Fallback: concat without audio crossfade (some Veo videos have no audio)
                cmd_fallback = [
                    "ffmpeg", "-y", "-i", str(p1), "-i", str(p2),
                    "-filter_complex",
                    f"[0:v][1:v]xfade=transition=fade:duration={crossfade_dur}:offset={offset}[vout]",
                    "-map", "[vout]",
                    "-c:v", "libx264", "-preset", "fast", "-crf", "20",
                    "-an",
                    "-movflags", "+faststart",
                    str(out),
                ]
                subprocess.run(cmd_fallback, capture_output=True, timeout=120, check=True)

            return out.read_bytes()
        finally:
            shutil.rmtree(tmpdir, ignore_errors=True)

    # Continuation prompt prefix — instructs the model to seamlessly continue
    # from the provided first frame, preserving visual identity.
    _CONTINUATION_PREFIX = (
        "Seamlessly continue from the provided first frame. "
        "Maintain identical lighting, color palette, camera style, "
        "and subject appearance throughout. "
    )

    @app.post("/api/veo/local-chain")
    def api_veo_local_chain():
        """Generate 16/24s video locally: seg1 → extract last frame → seg2(image mode) → crossfade.

        No GCS needed. Visual continuity via last-frame-as-first-frame.

        Optimizations over generate-16s:
        1. Continuation prompt: seg2+ gets explicit "continue from first frame" instruction
        2. Image mode: seg2 uses last frame of seg1 as first frame (not blind parallel)
        3. Crossfade: smooth fade transition instead of hard cut
        4. Fast polling: reduced initial wait for fast models

        Required: prompt
        Optional: model, aspect_ratio, target_total_seconds (16|24), crossfade_seconds
        """
        _t0 = time.monotonic()
        payload = request.get_json(silent=True) or {}
        try:
            project_id, key_file, proxy, model = parse_common_payload(payload)
            prompt = (payload.get("prompt") or "").strip()
            if not prompt:
                return json_error("prompt 不能为空")
            if not model:
                model = "veo-3.1-fast-generate-001"

            aspect_ratio = (payload.get("aspect_ratio") or "9:16").strip()
            target_total = int(payload.get("target_total_seconds", 16))
            crossfade_dur = float(payload.get("crossfade_seconds", 0.5))
            num_segments = max(2, target_total // 8)

            # Adaptive polling: fast models need less initial wait
            is_fast = "fast" in model.lower()
            initial_wait = 15 if is_fast else 25
            poll_interval = 6

            # Split prompt for segments
            try:
                parts = split_prompt_for_16s(prompt)
                prompt_a = parts.get("part1", prompt)
                prompt_b_raw = parts.get("part2", prompt)
            except Exception:
                prompt_a = prompt
                prompt_b_raw = prompt

            token = get_access_token(key_file, proxy)
            base_params = {"sampleCount": 1, "durationSeconds": 8, "aspectRatio": aspect_ratio}

            segments_bytes: list = []
            seg_times: list = []

            # === Segment 1: text-to-video ===
            seg1_t0 = time.time()
            body1 = {
                "instances": [{"prompt": prompt_a}],
                "parameters": dict(base_params),
            }
            sc, ok, data1 = _call_predict_long_running(
                project_id=project_id, model=model, token=token, proxy=proxy, body=body1,
            )
            if not ok:
                return json_error(f"Segment 1 submit failed (status={sc}): {data1}", 502)
            op1 = data1.get("name", "")

            seg1_bytes, _ = _poll_inline_video(
                project_id=project_id, model=model, token=token, proxy=proxy,
                operation_name=op1, initial_wait_seconds=initial_wait,
                poll_interval_seconds=poll_interval,
            )
            segments_bytes.append(seg1_bytes)
            seg_times.append(round(time.time() - seg1_t0, 1))

            # === Segment 2+: image-to-video (last frame continuation) ===
            for seg_idx in range(1, num_segments):
                seg_t0 = time.time()
                last_frame_b64, last_frame_mime = _extract_last_frame(segments_bytes[-1])

                # Build continuation prompt: prefix + segment-specific content
                if seg_idx == 1:
                    seg_prompt = _CONTINUATION_PREFIX + prompt_b_raw
                else:
                    seg_prompt = (
                        _CONTINUATION_PREFIX
                        + f"This is part {seg_idx + 1} of the scene. "
                        + prompt_b_raw
                    )

                instance = {
                    "prompt": seg_prompt,
                    "image": {
                        "bytesBase64Encoded": last_frame_b64,
                        "mimeType": last_frame_mime,
                    },
                }
                body_n = {"instances": [instance], "parameters": dict(base_params)}
                sc, ok, data_n = _call_predict_long_running(
                    project_id=project_id, model=model, token=token, proxy=proxy, body=body_n,
                )
                if not ok:
                    return json_error(f"Segment {seg_idx + 1} submit failed (status={sc}): {data_n}", 502)
                op_n = data_n.get("name", "")

                seg_bytes, _ = _poll_inline_video(
                    project_id=project_id, model=model, token=token, proxy=proxy,
                    operation_name=op_n, initial_wait_seconds=initial_wait,
                    poll_interval_seconds=poll_interval,
                )
                segments_bytes.append(seg_bytes)
                seg_times.append(round(time.time() - seg_t0, 1))

            # === Crossfade concat ===
            if len(segments_bytes) == 2:
                final_bytes = _crossfade_concat(segments_bytes[0], segments_bytes[1], crossfade_dur)
            else:
                # Multi-segment: sequential crossfade
                acc = segments_bytes[0]
                for i in range(1, len(segments_bytes)):
                    acc = _crossfade_concat(acc, segments_bytes[i], crossfade_dur)
                final_bytes = acc

            # Save to export dir
            out_name = f"veo_chain_{uuid.uuid4().hex[:10]}.mp4"
            out_path = video_export_dir / out_name
            out_path.write_bytes(final_bytes)

            total_dur = round(time.monotonic() - _t0, 1)
            audit_log.record(
                tool="generate_video",
                action="veo_local_chain",
                input_summary={
                    "model": model,
                    "segments": num_segments,
                    "target_total_seconds": target_total,
                    "prompt_length": len(prompt),
                },
                output_summary={
                    "ok": True,
                    "file": out_name,
                    "file_size_kb": len(final_bytes) // 1024,
                    "segment_times": seg_times,
                },
                status="success",
                duration_ms=int(total_dur * 1000),
            )

            return jsonify({
                "ok": True,
                "status": "completed",
                "video_url": f"/video_edits/{out_name}",
                "filename": out_name,
                "model": model,
                "segments": num_segments,
                "segment_times_seconds": seg_times,
                "crossfade_seconds": crossfade_dur,
                "total_elapsed_seconds": total_dur,
                "file_size_kb": len(final_bytes) // 1024,
                "method": "local-chain: seg1(text) → last_frame → seg2(image) → crossfade",
            })
        except TimeoutError as e:
            return json_error(str(e), 504, "Increase max_wait_seconds or try a shorter prompt.")
        except Exception as e:
            _dur_ms = int((time.monotonic() - _t0) * 1000)
            audit_log.record(
                tool="generate_video", action="veo_local_chain",
                input_summary={"prompt_length": len(str(payload.get("prompt") or ""))},
                output_summary={"error": str(e)[:120]},
                status="error", error_code="VEO_LOCAL_CHAIN_FAILED", duration_ms=_dur_ms,
            )
            return json_error(f"Local chain failed: {e}", 500)
