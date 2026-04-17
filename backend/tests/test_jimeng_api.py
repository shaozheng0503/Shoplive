"""Tests for Jimeng client-side retry on 503/5xx/429 upstream failures."""

import io
import os
from unittest.mock import patch

import pytest
from flask import Flask, jsonify


class _FakeResp:
    def __init__(self, status_code=200, payload=None, text=""):
        self.status_code = status_code
        self.ok = 200 <= status_code < 400
        self._payload = payload if payload is not None else {"data": [{"url": "https://cdn/x.mp4"}]}
        self.text = text

    def json(self):
        return self._payload


def _json_error(message, status=400, recovery_suggestion=None, **extra):
    payload = {"ok": False, "error": message}
    if recovery_suggestion:
        payload["recovery_suggestion"] = recovery_suggestion
    payload.update(extra)
    return jsonify(payload), status


@pytest.fixture()
def jimeng_app(monkeypatch):
    from shoplive.backend.api.jimeng_api import register_jimeng_routes

    monkeypatch.setenv("JIMENG_API_KEY", "test-key-xxxx")
    app = Flask(__name__)
    app.config["TESTING"] = True
    register_jimeng_routes(app, json_error=_json_error, build_proxies=lambda *_a, **_k: {})
    return app


def _video_body():
    return {"prompt": "cat in space", "model": "3.0", "duration": 5, "ratio": "16:9", "resolution": "720p"}


class TestPostWithRetry:
    def test_rewind_files_resets_streams(self):
        from shoplive.backend.api.jimeng_api import _rewind_files
        stream = io.BytesIO(b"hello")
        stream.read()  # advance to end
        files = {"image_file_1": ("x.jpg", stream, "image/jpeg")}
        _rewind_files(files)
        assert stream.tell() == 0
        assert stream.read() == b"hello"

    def test_success_on_first_attempt_no_retry(self, jimeng_app):
        calls = []

        def fake_post(endpoint, **kwargs):
            calls.append(endpoint)
            return _FakeResp(200)

        sleeps = []
        with patch("shoplive.backend.api.jimeng_api.requests.post", side_effect=fake_post), \
             patch("shoplive.backend.api.jimeng_api.time.sleep", side_effect=sleeps.append):
            resp = jimeng_app.test_client().post("/api/jimeng/video", json=_video_body())
        assert resp.status_code == 200
        assert resp.get_json()["attempts"] == 1
        assert len(calls) == 1
        assert sleeps == []

    def test_503_then_success_retries_and_sleeps(self, jimeng_app):
        responses = [_FakeResp(503, {"code": 503, "msg": "暂无SessionId"}), _FakeResp(200)]

        def fake_post(endpoint, **kwargs):
            return responses.pop(0)

        sleeps = []
        with patch("shoplive.backend.api.jimeng_api.requests.post", side_effect=fake_post), \
             patch("shoplive.backend.api.jimeng_api.time.sleep", side_effect=sleeps.append):
            resp = jimeng_app.test_client().post("/api/jimeng/video", json=_video_body())
        body = resp.get_json()
        assert resp.status_code == 200
        assert body["attempts"] == 2
        assert sleeps == [3.0]  # one backoff before second attempt

    def test_all_attempts_503_returns_upstream_error_with_attempt_count(self, jimeng_app):
        responses = [_FakeResp(503, {"msg": "暂无SessionId"}) for _ in range(5)]

        def fake_post(endpoint, **kwargs):
            return responses.pop(0)

        sleeps = []
        with patch("shoplive.backend.api.jimeng_api.requests.post", side_effect=fake_post), \
             patch("shoplive.backend.api.jimeng_api.time.sleep", side_effect=sleeps.append):
            resp = jimeng_app.test_client().post("/api/jimeng/video", json=_video_body())
        body = resp.get_json()
        assert resp.status_code == 503
        assert "3 attempt(s)" in body["error"]
        assert "SessionId pool exhausted" in body["recovery_suggestion"]
        assert sleeps == [3.0, 8.0]

    def test_401_is_not_retried(self, jimeng_app):
        calls = []

        def fake_post(endpoint, **kwargs):
            calls.append(endpoint)
            return _FakeResp(401, {"msg": "bad token"})

        sleeps = []
        with patch("shoplive.backend.api.jimeng_api.requests.post", side_effect=fake_post), \
             patch("shoplive.backend.api.jimeng_api.time.sleep", side_effect=sleeps.append):
            resp = jimeng_app.test_client().post("/api/jimeng/video", json=_video_body())
        assert resp.status_code == 401
        assert len(calls) == 1  # no retry for 401
        assert sleeps == []

    def test_429_is_retried(self, jimeng_app):
        responses = [_FakeResp(429, {"msg": "rate limit"}), _FakeResp(200)]

        def fake_post(endpoint, **kwargs):
            return responses.pop(0)

        with patch("shoplive.backend.api.jimeng_api.requests.post", side_effect=fake_post), \
             patch("shoplive.backend.api.jimeng_api.time.sleep"):
            resp = jimeng_app.test_client().post("/api/jimeng/video", json=_video_body())
        assert resp.status_code == 200
        assert resp.get_json()["attempts"] == 2

    def test_image_endpoint_also_retries(self, jimeng_app):
        responses = [
            _FakeResp(503, {"msg": "暂无SessionId"}),
            _FakeResp(200, {"data": [{"url": "https://cdn/a.png"}]}),
        ]

        def fake_post(endpoint, **kwargs):
            return responses.pop(0)

        with patch("shoplive.backend.api.jimeng_api.requests.post", side_effect=fake_post), \
             patch("shoplive.backend.api.jimeng_api.time.sleep"):
            resp = jimeng_app.test_client().post(
                "/api/jimeng/image",
                json={"prompt": "cat", "model": "jimeng-4.6", "ratio": "1:1", "resolution": "2k"},
            )
        body = resp.get_json()
        assert resp.status_code == 200
        assert body["attempts"] == 2
