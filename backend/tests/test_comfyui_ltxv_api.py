"""
Unit tests for ComfyUI LTX-Video API (comfyui_ltxv_api.py).

All ComfyUI HTTP calls are mocked — no external services are touched.

Covered:
  GET  /api/comfyui-ltxv/status      — reachability check
  POST /api/comfyui-ltxv/generate    — text-to-video, image-to-video, validation
  GET  /api/comfyui-ltxv/download/<f> — file serving
"""

import base64
import json
import tempfile
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------

@pytest.fixture()
def app():
    """Create a minimal Flask app with comfyui-ltxv routes registered."""
    from flask import Flask, jsonify

    application = Flask(__name__)
    application.config["TESTING"] = True

    def json_error(msg, status=400, recovery=None):
        body = {"ok": False, "error": msg}
        if recovery:
            body["recovery_suggestion"] = recovery
        return jsonify(body), status

    with tempfile.TemporaryDirectory() as td:
        export_dir = Path(td)
        from shoplive.backend.api.comfyui_ltxv_api import register_comfyui_ltxv_routes
        register_comfyui_ltxv_routes(
            application,
            json_error=json_error,
            video_export_dir=export_dir,
        )
        # Store export dir on app so tests can access it
        application._export_dir = export_dir
        yield application


@pytest.fixture()
def client(app):
    return app.test_client()


# ---------------------------------------------------------------------------
# /api/comfyui-ltxv/status
# ---------------------------------------------------------------------------

class TestStatus:
    def test_status_ok(self, client):
        mock_resp = MagicMock()
        mock_resp.ok = True
        with patch("shoplive.backend.api.comfyui_ltxv_api.requests.get", return_value=mock_resp):
            r = client.get("/api/comfyui-ltxv/status")
        assert r.status_code == 200
        data = r.get_json()
        assert data["ok"] is True
        assert "comfyui_url" in data

    def test_status_unreachable(self, client):
        with patch("shoplive.backend.api.comfyui_ltxv_api.requests.get", side_effect=ConnectionError("refused")):
            r = client.get("/api/comfyui-ltxv/status")
        data = r.get_json()
        assert data["ok"] is False
        assert "refused" in data["error"]


# ---------------------------------------------------------------------------
# /api/comfyui-ltxv/generate — validation
# ---------------------------------------------------------------------------

class TestGenerateValidation:
    def test_missing_prompt_returns_400(self, client):
        r = client.post("/api/comfyui-ltxv/generate",
                        json={"model": "LTX-2 (Pro)"})
        assert r.status_code == 400
        assert "prompt" in r.get_json()["error"]

    def test_empty_prompt_returns_400(self, client):
        r = client.post("/api/comfyui-ltxv/generate",
                        json={"prompt": "   "})
        assert r.status_code == 400

    def test_invalid_duration_too_short(self, client):
        r = client.post("/api/comfyui-ltxv/generate",
                        json={"prompt": "test", "duration": 2})
        assert r.status_code == 400
        assert "duration" in r.get_json()["error"].lower()

    def test_invalid_duration_too_long(self, client):
        r = client.post("/api/comfyui-ltxv/generate",
                        json={"prompt": "test", "duration": 30})
        assert r.status_code == 400


# ---------------------------------------------------------------------------
# /api/comfyui-ltxv/generate — text-to-video (happy path)
# ---------------------------------------------------------------------------

class TestGenerateText2Video:
    def _mock_comfyui_flow(self):
        """Return patches that simulate a successful ComfyUI text-to-video."""
        fake_video = b"\x00\x00\x00\x20ftypmp42" + b"\x00" * 100

        submit_resp = MagicMock()
        submit_resp.status_code = 200
        submit_resp.ok = True
        submit_resp.json.return_value = {"prompt_id": "test-prompt-123"}
        submit_resp.raise_for_status = MagicMock()

        history_entry = {
            "status": {"completed": True, "status_str": "success"},
            "outputs": {
                "15": {
                    "videos": [{"filename": "ltxv_comfy_00001.mp4", "subfolder": "", "type": "output"}]
                }
            },
        }

        history_resp = MagicMock()
        history_resp.ok = True
        history_resp.json.return_value = {"test-prompt-123": history_entry}

        download_resp = MagicMock()
        download_resp.content = fake_video
        download_resp.raise_for_status = MagicMock()

        def mock_post(url, **kwargs):
            if "/prompt" in url:
                return submit_resp
            return MagicMock()

        def mock_get(url, **kwargs):
            if "/history/" in url:
                return history_resp
            if "/view" in url:
                return download_resp
            return MagicMock()

        return mock_get, mock_post

    def test_text2video_success(self, client, app):
        mock_get, mock_post = self._mock_comfyui_flow()
        with patch("shoplive.backend.api.comfyui_ltxv_api.requests.get", side_effect=mock_get), \
             patch("shoplive.backend.api.comfyui_ltxv_api.requests.post", side_effect=mock_post):
            r = client.post("/api/comfyui-ltxv/generate", json={
                "prompt": "A beautiful sunset over the ocean",
                "model": "LTX-2 (Pro)",
                "duration": 10,
                "resolution": "1920x1080",
                "fps": 25,
            })
        assert r.status_code == 200
        data = r.get_json()
        assert data["status"] == "completed"
        assert data["model"] == "LTX-2 (Pro)"
        assert data["duration"] == 10
        assert data["resolution"] == "1920x1080"
        assert data["mode"] == "text2video"
        assert "/api/comfyui-ltxv/download/" in data["video_url"]
        assert data["prompt_id"] == "test-prompt-123"

    def test_text2video_portrait_resolution(self, client, app):
        """Verify portrait resolution (1080x1920) is accepted and passed through."""
        mock_get, mock_post = self._mock_comfyui_flow()
        with patch("shoplive.backend.api.comfyui_ltxv_api.requests.get", side_effect=mock_get), \
             patch("shoplive.backend.api.comfyui_ltxv_api.requests.post", side_effect=mock_post):
            r = client.post("/api/comfyui-ltxv/generate", json={
                "prompt": "Product showcase",
                "resolution": "1080x1920",
            })
        assert r.status_code == 200
        assert r.get_json()["resolution"] == "1080x1920"

    def test_text2video_comfyui_timeout(self, client):
        submit_resp = MagicMock()
        submit_resp.ok = True
        submit_resp.json.return_value = {"prompt_id": "test-timeout"}
        submit_resp.raise_for_status = MagicMock()

        with patch("shoplive.backend.api.comfyui_ltxv_api.requests.post", return_value=submit_resp), \
             patch("shoplive.backend.api.comfyui_ltxv_api._poll_completion",
                   side_effect=TimeoutError("timeout")):
            r = client.post("/api/comfyui-ltxv/generate", json={"prompt": "test"})
        assert r.status_code == 504
        assert "timeout" in r.get_json()["error"].lower()

    def test_text2video_comfyui_no_prompt_id(self, client):
        submit_resp = MagicMock()
        submit_resp.ok = True
        submit_resp.json.return_value = {}
        submit_resp.raise_for_status = MagicMock()

        with patch("shoplive.backend.api.comfyui_ltxv_api.requests.post", return_value=submit_resp):
            r = client.post("/api/comfyui-ltxv/generate", json={"prompt": "test"})
        assert r.status_code == 502
        assert "prompt_id" in r.get_json()["error"]


# ---------------------------------------------------------------------------
# /api/comfyui-ltxv/generate — image-to-video
# ---------------------------------------------------------------------------

class TestGenerateImage2Video:
    def test_image2video_base64(self, client, app):
        fake_video = b"\x00\x00\x00\x20ftypmp42" + b"\x00" * 80
        fake_img_b64 = base64.b64encode(b"\x89PNG\r\n\x1a\n" + b"\x00" * 50).decode()

        submit_resp = MagicMock()
        submit_resp.ok = True
        submit_resp.json.return_value = {"prompt_id": "img-test-001"}
        submit_resp.raise_for_status = MagicMock()

        upload_resp = MagicMock()
        upload_resp.ok = True
        upload_resp.json.return_value = {"name": "uploaded_img.png"}
        upload_resp.raise_for_status = MagicMock()

        history_entry = {
            "status": {"completed": True},
            "outputs": {"16": {"videos": [{"filename": "out.mp4", "subfolder": "", "type": "output"}]}},
        }
        history_resp = MagicMock()
        history_resp.ok = True
        history_resp.json.return_value = {"img-test-001": history_entry}

        download_resp = MagicMock()
        download_resp.content = fake_video
        download_resp.raise_for_status = MagicMock()

        call_count = {"post": 0}

        def mock_post(url, **kwargs):
            call_count["post"] += 1
            if "/upload/image" in url:
                return upload_resp
            if "/prompt" in url:
                return submit_resp
            return MagicMock()

        def mock_get(url, **kwargs):
            if "/history/" in url:
                return history_resp
            if "/view" in url:
                return download_resp
            return MagicMock()

        with patch("shoplive.backend.api.comfyui_ltxv_api.requests.get", side_effect=mock_get), \
             patch("shoplive.backend.api.comfyui_ltxv_api.requests.post", side_effect=mock_post):
            r = client.post("/api/comfyui-ltxv/generate", json={
                "prompt": "Product video",
                "image_base64": f"data:image/png;base64,{fake_img_b64}",
            })
        assert r.status_code == 200
        data = r.get_json()
        assert data["mode"] == "image2video"
        assert call_count["post"] >= 2  # upload + submit


# ---------------------------------------------------------------------------
# /api/comfyui-ltxv/download
# ---------------------------------------------------------------------------

class TestDownload:
    def test_download_existing_file(self, client, app):
        # Write a test file to the export dir
        test_file = app._export_dir / "test_video.mp4"
        test_file.write_bytes(b"fake-video-data")

        r = client.get("/api/comfyui-ltxv/download/test_video.mp4")
        assert r.status_code == 200
        assert r.data == b"fake-video-data"

    def test_download_missing_file(self, client):
        r = client.get("/api/comfyui-ltxv/download/nonexistent.mp4")
        assert r.status_code == 404


# ---------------------------------------------------------------------------
# Resolution mapping — unit tests for _RES_TO_LATENT
# ---------------------------------------------------------------------------

class TestResolutionMapping:
    def test_16_9_resolutions(self):
        from shoplive.backend.api.comfyui_ltxv_api import _RES_TO_LATENT
        for key in ["1920x1080", "2560x1440", "3840x2160", "1280x720"]:
            w, h = _RES_TO_LATENT[key]
            ratio = w / h
            assert abs(ratio - 16 / 9) < 0.01, f"{key} maps to {w}x{h} = {ratio:.3f}, expected 16:9"
            assert w % 64 == 0, f"{key}: width {w} not multiple of 64"
            assert h % 64 == 0, f"{key}: height {h} not multiple of 64"

    def test_9_16_resolutions(self):
        from shoplive.backend.api.comfyui_ltxv_api import _RES_TO_LATENT
        for key in ["1080x1920", "1440x2560", "2160x3840", "720x1280"]:
            w, h = _RES_TO_LATENT[key]
            ratio = w / h
            assert abs(ratio - 9 / 16) < 0.01, f"{key} maps to {w}x{h} = {ratio:.3f}, expected 9:16"
            assert w % 64 == 0
            assert h % 64 == 0

    def test_default_fallback_is_16_9(self):
        from shoplive.backend.api.comfyui_ltxv_api import _RES_TO_LATENT
        # Verify that an unknown key falls back to 16:9 default (1024, 576)
        w, h = _RES_TO_LATENT.get("9999x9999", (1024, 576))
        assert (w, h) == (1024, 576)


# ---------------------------------------------------------------------------
# Workflow builder — unit tests
# ---------------------------------------------------------------------------

class TestWorkflowBuilder:
    def test_text2video_workflow_structure(self):
        from shoplive.backend.api.comfyui_ltxv_api import _build_text2video_workflow
        wf = _build_text2video_workflow("a cat", model="LTX-2 (Pro)", duration=10, resolution="1920x1080")
        prompt_nodes = wf["prompt"]
        # Must have EmptyLTXVLatentVideo node with correct dimensions
        node5 = prompt_nodes["5"]
        assert node5["class_type"] == "EmptyLTXVLatentVideo"
        assert node5["inputs"]["width"] == 1024
        assert node5["inputs"]["height"] == 576

    def test_text2video_portrait_dimensions(self):
        from shoplive.backend.api.comfyui_ltxv_api import _build_text2video_workflow
        wf = _build_text2video_workflow("a product", resolution="1080x1920")
        node5 = wf["prompt"]["5"]
        assert node5["inputs"]["width"] == 576
        assert node5["inputs"]["height"] == 1024

    def test_image2video_workflow_structure(self):
        from shoplive.backend.api.comfyui_ltxv_api import _build_image2video_workflow
        wf = _build_image2video_workflow("a product video", image_name="test.png", resolution="1920x1080")
        prompt_nodes = wf["prompt"]
        # Must have LoadImage node
        node5 = prompt_nodes["5"]
        assert node5["class_type"] == "LoadImage"
        assert node5["inputs"]["image"] == "test.png"
        # Must have LTXVImgToVideo with correct dims
        node6 = prompt_nodes["6"]
        assert node6["class_type"] == "LTXVImgToVideo"
        assert node6["inputs"]["width"] == 1024
        assert node6["inputs"]["height"] == 576

    def test_fast_model_picks_distilled_ckpt(self):
        from shoplive.backend.api.comfyui_ltxv_api import _pick_ckpt
        assert "distilled" in _pick_ckpt("LTX-2 (Fast)")
        assert "dev" in _pick_ckpt("LTX-2 (Pro)")

    def test_duration_to_length(self):
        from shoplive.backend.api.comfyui_ltxv_api import _duration_to_length
        length = _duration_to_length(10, 25)
        assert length >= 9
        assert (length - 1) % 8 == 0  # Must be 8*n + 1
