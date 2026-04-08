"""
ComfyUI LTX-Video proxy — submit workflow to remote ComfyUI, poll & return video.

Uses native LTX 2.3 nodes in ComfyUI (no LtxvApi* login-dependent nodes).

Routes:
  POST /api/comfyui-ltxv/generate  — text-to-video or image-to-video via ComfyUI
  GET  /api/comfyui-ltxv/status    — check if ComfyUI is reachable

Env:
  COMFYUI_URL — defaults to https://development-452-9smwwyd2-8188.550w.link
"""

import base64
import io
import os
import time
import uuid
from pathlib import Path
from typing import Callable, Dict, Optional

import requests
from flask import g, jsonify, request, send_from_directory

from shoplive.backend.audit import audit_log

_DEFAULT_COMFYUI_URL = "https://development-452-9smwwyd2-8188.550w.link"
_POLL_INTERVAL = 2   # lowered from 5 s — ComfyUI is local/LAN, round-trip ~10ms
_MAX_WAIT = 1200  # 20 min — queue wait + generation for 16s


def _get_comfyui_url() -> str:
    return os.environ.get("COMFYUI_URL", _DEFAULT_COMFYUI_URL).rstrip("/")


_CKPT_DEV = "ltx-2.3-22b-dev-fp8.safetensors"
_CKPT_FAST = "ltx-2.3-22b-distilled-fp8.safetensors"
_TEXT_ENCODER = "gemma_3_12B_it_fp8_scaled.safetensors"

# Resolution presets for EmptyLTXVLatentVideo / LTXVImgToVideo.
# Dimensions must be multiples of 64 and preserve the exact aspect ratio.
_RES_TO_LATENT = {
    # 16:9 landscape
    "1920x1080": (1024, 576),
    "2560x1440": (1024, 576),
    "3840x2160": (1024, 576),
    "1280x720":  (1024, 576),
    # 9:16 portrait
    "1080x1920": (576, 1024),
    "1440x2560": (576, 1024),
    "2160x3840": (576, 1024),
    "720x1280":  (576, 1024),
}


def _pick_ckpt(model: str) -> str:
    m = str(model or "").lower()
    if "fast" in m or "distilled" in m:
        return _CKPT_FAST
    return _CKPT_DEV


def _duration_to_length(duration_s: int, fps: int = 25) -> int:
    """Convert seconds to LTX frame length (8*n + 1)."""
    target = max(1, int(duration_s)) * max(1, int(fps))
    n = round((target - 1) / 8)
    return max(9, 8 * n + 1)


def _build_text2video_workflow(
    prompt: str,
    model: str = "LTX-2 (Pro)",
    duration: int = 10,
    resolution: str = "1920x1080",
    fps: int = 25,
    generate_audio: bool = False,
) -> Dict:
    """Build native ComfyUI LTX workflow for text-to-video."""
    ckpt = _pick_ckpt(model)
    width, height = _RES_TO_LATENT.get(resolution, (1024, 576))
    length = _duration_to_length(duration, fps)
    return {
        "prompt": {
            "1": {"class_type": "CheckpointLoaderSimple", "inputs": {"ckpt_name": ckpt}},
            "2": {"class_type": "LTXAVTextEncoderLoader", "inputs": {
                "text_encoder": _TEXT_ENCODER, "ckpt_name": ckpt, "device": "default",
            }},
            "3": {"class_type": "CLIPTextEncode", "inputs": {"text": prompt, "clip": ["2", 0]}},
            "4": {"class_type": "CLIPTextEncode", "inputs": {"text": "", "clip": ["2", 0]}},
            "5": {"class_type": "EmptyLTXVLatentVideo", "inputs": {
                "width": width, "height": height, "length": length, "batch_size": 1,
            }},
            "6": {"class_type": "LTXVConditioning", "inputs": {
                "positive": ["3", 0], "negative": ["4", 0], "frame_rate": float(fps),
            }},
            "7": {"class_type": "ModelSamplingLTXV", "inputs": {
                "model": ["1", 0], "max_shift": 2.05, "base_shift": 0.95, "latent": ["5", 0],
            }},
            "8": {"class_type": "LTXVScheduler", "inputs": {
                "steps": 20, "max_shift": 2.05, "base_shift": 0.95,
                "stretch": True, "terminal": 0.1, "latent": ["5", 0],
            }},
            "9": {"class_type": "KSamplerSelect", "inputs": {"sampler_name": "euler"}},
            "10": {"class_type": "RandomNoise", "inputs": {"noise_seed": 0}},
            "11": {"class_type": "CFGGuider", "inputs": {
                "model": ["7", 0], "positive": ["6", 0], "negative": ["6", 1], "cfg": 3.0,
            }},
            "12": {"class_type": "SamplerCustomAdvanced", "inputs": {
                "noise": ["10", 0], "guider": ["11", 0], "sampler": ["9", 0],
                "sigmas": ["8", 0], "latent_image": ["5", 0],
            }},
            "13": {"class_type": "VAEDecode", "inputs": {"samples": ["12", 0], "vae": ["1", 2]}},
            "14": {"class_type": "CreateVideo", "inputs": {"images": ["13", 0], "fps": float(fps)}},
            "15": {"class_type": "SaveVideo", "inputs": {
                "video": ["14", 0], "filename_prefix": "ltxv_comfy", "format": "mp4", "codec": "h264",
            }},
        }
    }


def _build_image2video_workflow(
    prompt: str,
    image_name: str,
    model: str = "LTX-2 (Pro)",
    duration: int = 10,
    resolution: str = "1920x1080",
    fps: int = 25,
    generate_audio: bool = False,
) -> Dict:
    """Build native ComfyUI LTX workflow for image-to-video."""
    ckpt = _pick_ckpt(model)
    width, height = _RES_TO_LATENT.get(resolution, (1024, 576))
    length = _duration_to_length(duration, fps)
    return {
        "prompt": {
            "1": {"class_type": "CheckpointLoaderSimple", "inputs": {"ckpt_name": ckpt}},
            "2": {"class_type": "LTXAVTextEncoderLoader", "inputs": {
                "text_encoder": _TEXT_ENCODER, "ckpt_name": ckpt, "device": "default",
            }},
            "3": {"class_type": "CLIPTextEncode", "inputs": {"text": prompt, "clip": ["2", 0]}},
            "4": {"class_type": "CLIPTextEncode", "inputs": {"text": "", "clip": ["2", 0]}},
            "5": {"class_type": "LoadImage", "inputs": {"image": image_name}},
            "6": {"class_type": "LTXVImgToVideo", "inputs": {
                "positive": ["3", 0], "negative": ["4", 0], "vae": ["1", 2], "image": ["5", 0],
                "width": width, "height": height, "length": length, "batch_size": 1, "strength": 1.0,
            }},
            "7": {"class_type": "LTXVConditioning", "inputs": {
                "positive": ["6", 0], "negative": ["6", 1], "frame_rate": float(fps),
            }},
            "8": {"class_type": "ModelSamplingLTXV", "inputs": {
                "model": ["1", 0], "max_shift": 2.05, "base_shift": 0.95, "latent": ["6", 2],
            }},
            "9": {"class_type": "LTXVScheduler", "inputs": {
                "steps": 20, "max_shift": 2.05, "base_shift": 0.95,
                "stretch": True, "terminal": 0.1, "latent": ["6", 2],
            }},
            "10": {"class_type": "KSamplerSelect", "inputs": {"sampler_name": "euler"}},
            "11": {"class_type": "RandomNoise", "inputs": {"noise_seed": 0}},
            "12": {"class_type": "CFGGuider", "inputs": {
                "model": ["8", 0], "positive": ["7", 0], "negative": ["7", 1], "cfg": 3.0,
            }},
            "13": {"class_type": "SamplerCustomAdvanced", "inputs": {
                "noise": ["11", 0], "guider": ["12", 0], "sampler": ["10", 0],
                "sigmas": ["9", 0], "latent_image": ["6", 2],
            }},
            "14": {"class_type": "VAEDecode", "inputs": {"samples": ["13", 0], "vae": ["1", 2]}},
            "15": {"class_type": "CreateVideo", "inputs": {"images": ["14", 0], "fps": float(fps)}},
            "16": {"class_type": "SaveVideo", "inputs": {
                "video": ["15", 0], "filename_prefix": "ltxv_comfy",
                "format": "mp4", "codec": "h264",
            }},
        }
    }


def _upload_image_to_comfyui(comfyui_url: str, image_bytes: bytes, filename: str) -> str:
    """Upload an image to ComfyUI and return the server-side filename."""
    resp = requests.post(
        f"{comfyui_url}/upload/image",
        files={"image": (filename, io.BytesIO(image_bytes), "image/png")},
        data={"overwrite": "true"},
        timeout=30,
    )
    resp.raise_for_status()
    data = resp.json()
    return data.get("name", filename)


def _submit_workflow(comfyui_url: str, workflow: Dict) -> str:
    """Submit workflow to ComfyUI, return prompt_id."""
    resp = requests.post(
        f"{comfyui_url}/prompt",
        json=workflow,
        timeout=30,
    )
    resp.raise_for_status()
    data = resp.json()
    return data.get("prompt_id", "")


def _poll_completion(comfyui_url: str, prompt_id: str, max_wait: int = _MAX_WAIT) -> Dict:
    """Poll ComfyUI /history/{prompt_id} until done or timeout."""
    deadline = time.time() + max_wait
    while time.time() < deadline:
        time.sleep(_POLL_INTERVAL)
        try:
            resp = requests.get(f"{comfyui_url}/history/{prompt_id}", timeout=15)
            if resp.ok:
                data = resp.json()
                entry = data.get(prompt_id)
                if entry and entry.get("status", {}).get("completed", False):
                    return entry
                if entry and entry.get("status", {}).get("status_str") == "error":
                    raise RuntimeError(f"ComfyUI workflow error: {entry.get('status')}")
        except requests.exceptions.RequestException:
            pass  # transient, keep polling
    raise TimeoutError(f"ComfyUI workflow timeout (>{max_wait}s)")


def _extract_output_video(comfyui_url: str, history_entry: Dict) -> Optional[Dict]:
    """Extract the first video output from ComfyUI history entry."""
    outputs = history_entry.get("outputs", {})
    for node_id, node_out in outputs.items():
        for key in ("videos", "images", "files"):
            items = node_out.get(key, [])
            if not items:
                continue
            v = items[0]
            filename = str(v.get("filename", ""))
            if not filename:
                continue
            # SaveVideo from some Comfy builds stores MP4 under "images".
            if filename.lower().endswith((".mp4", ".mov", ".webm")):
                return {
                    "filename": filename,
                    "subfolder": v.get("subfolder", ""),
                    "type": v.get("type", "output"),
                }
    return None


def _download_comfyui_video(comfyui_url: str, video_info: Dict) -> bytes:
    """Download video bytes from ComfyUI /view endpoint."""
    params = {
        "filename": video_info["filename"],
        "subfolder": video_info.get("subfolder", ""),
        "type": video_info.get("type", "output"),
    }
    resp = requests.get(f"{comfyui_url}/view", params=params, timeout=120)
    resp.raise_for_status()
    return resp.content


# ---------------------------------------------------------------------------
# Route registration
# ---------------------------------------------------------------------------

def register_comfyui_ltxv_routes(
    app,
    *,
    json_error: Callable,
    video_export_dir: Path = None,
):
    export_dir: Path = video_export_dir or (Path(__file__).parent.parent.parent / "video_edits")
    export_dir.mkdir(parents=True, exist_ok=True)

    @app.get("/api/comfyui-ltxv/download/<path:filename>")
    def api_comfyui_ltxv_download(filename):
        return send_from_directory(str(export_dir), filename)

    @app.get("/api/comfyui-ltxv/status")
    def api_comfyui_ltxv_status():
        """Check if the ComfyUI instance is reachable."""
        try:
            resp = requests.get(f"{_get_comfyui_url()}/system_stats", timeout=10)
            return jsonify({"ok": resp.ok, "comfyui_url": _get_comfyui_url()})
        except Exception as e:
            return jsonify({"ok": False, "error": str(e)})

    @app.post("/api/comfyui-ltxv/generate")
    def api_comfyui_ltxv_generate():
        """Generate video via native ComfyUI LTX 2.3 workflow.

        JSON body:
          prompt (str, required): video description
          model (str): "LTX-2 (Pro)" or "LTX-2 (Fast)", default Pro
          duration (int): 6/8/10/12/14/16/18/20, default 10
          resolution (str): "1920x1080", "2560x1440", "3840x2160"
          fps (int): 25 or 50
          generate_audio (bool): default false
          image_base64 (str, optional): first frame for image-to-video
          image_url (str, optional): first frame URL for image-to-video
        """
        t0 = time.time()
        payload = request.get_json(silent=True) or {}
        prompt_text = (payload.get("prompt") or "").strip()
        if not prompt_text:
            return json_error("prompt 不能为空")

        model = payload.get("model", "LTX-2 (Pro)")
        duration = int(payload.get("duration", 10))
        resolution = payload.get("resolution", "1920x1080")
        fps = int(payload.get("fps", 25))
        generate_audio = bool(payload.get("generate_audio", False))
        image_b64 = (payload.get("image_base64") or "").strip()
        image_url = (payload.get("image_url") or "").strip()

        if duration < 6 or duration > 20:
            return json_error("duration must be between 6 and 20 seconds")

        comfyui_url = _get_comfyui_url()
        is_image_mode = bool(image_b64 or image_url)

        try:
            if is_image_mode:
                # Upload image to ComfyUI first
                if image_b64:
                    if image_b64.startswith("data:"):
                        image_b64 = image_b64.split(",", 1)[-1]
                    img_bytes = base64.b64decode(image_b64)
                elif image_url:
                    resp = requests.get(image_url, timeout=30)
                    resp.raise_for_status()
                    img_bytes = resp.content
                else:
                    img_bytes = b""

                upload_name = f"ltxv_input_{uuid.uuid4().hex[:8]}.png"
                server_name = _upload_image_to_comfyui(comfyui_url, img_bytes, upload_name)
                workflow = _build_image2video_workflow(
                    prompt=prompt_text, image_name=server_name,
                    model=model, duration=duration, resolution=resolution,
                    fps=fps, generate_audio=generate_audio,
                )
            else:
                workflow = _build_text2video_workflow(
                    prompt=prompt_text, model=model, duration=duration,
                    resolution=resolution, fps=fps, generate_audio=generate_audio,
                )

            prompt_id = _submit_workflow(comfyui_url, workflow)
            if not prompt_id:
                return json_error("ComfyUI did not return a prompt_id", 502)

            # Poll until done
            history = _poll_completion(comfyui_url, prompt_id)
            video_info = _extract_output_video(comfyui_url, history)
            if not video_info:
                return json_error("ComfyUI workflow completed but no video output found", 502)

            # Download video from ComfyUI
            video_bytes = _download_comfyui_video(comfyui_url, video_info)

            # Save locally
            out_name = f"comfyui_ltxv_{uuid.uuid4().hex[:10]}.mp4"
            out_path = export_dir / out_name
            out_path.write_bytes(video_bytes)

            dur_ms = int((time.time() - t0) * 1000)
            audit_log.record(
                tool="generate_video_comfyui_ltxv",
                action="comfyui_ltxv_done",
                input_summary={
                    "model": model,
                    "mode": "image2video" if is_image_mode else "text2video",
                    "duration": duration,
                    "resolution": resolution,
                },
                output_summary={
                    "file": out_name,
                    "file_size_kb": len(video_bytes) // 1024,
                    "prompt_id": prompt_id,
                },
                status="success",
                duration_ms=dur_ms,
            )

            return jsonify({
                "status": "completed",
                "video_url": f"/api/comfyui-ltxv/download/{out_name}",
                "filename": out_name,
                "model": model,
                "duration": duration,
                "resolution": resolution,
                "mode": "image2video" if is_image_mode else "text2video",
                "prompt_id": prompt_id,
                "file_size_kb": len(video_bytes) // 1024,
                "elapsed_seconds": round((time.time() - t0), 1),
            })

        except TimeoutError as e:
            return json_error(str(e), 504, "ComfyUI workflow timed out. Try a shorter duration.")
        except Exception as e:
            err_text = str(e)
            dur_ms = int((time.time() - t0) * 1000)
            audit_log.record(
                tool="generate_video_comfyui_ltxv",
                action="comfyui_ltxv_error",
                input_summary={"model": model, "duration": duration},
                output_summary={"error": err_text[:120]},
                status="error",
                error_code="COMFYUI_LTXV_ERROR",
                duration_ms=dur_ms,
            )
            return json_error(f"ComfyUI LTX-Video error: {err_text}", 502)
