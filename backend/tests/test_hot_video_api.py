import json

import pytest
from flask import Flask, jsonify


class _VertexResp:
    def __init__(self, payload, status_code=200):
        self._payload = payload
        self.status_code = status_code

    def raise_for_status(self):
        if self.status_code >= 400:
            raise RuntimeError(f"HTTP {self.status_code}")

    def json(self):
        return self._payload


@pytest.fixture()
def hot_video_client():
    from shoplive.backend.api.hot_video_api import register_hot_video_routes

    llm_state = {
        "response": (200, {"ok": True, "response": {"choices": [{"message": {"content": "{}"}}]}}),
    }

    def _json_error(message, status=400, **extra):
        payload = {"ok": False, "error": message}
        payload.update(extra)
        return jsonify(payload), status

    def _call_litellm_chat(**_kwargs):
        return llm_state["response"]

    def _extract_chat_content(data):
        return data["choices"][0]["message"]["content"]

    def _try_parse_json_object(text):
        return json.loads(text)

    app = Flask(__name__)
    app.config["TESTING"] = True
    register_hot_video_routes(
        app,
        json_error=_json_error,
        parse_common_payload=lambda payload: ("demo-project", "/tmp/fake-key.json", payload.get("proxy", ""), payload.get("model", "")),
        get_access_token=lambda *_args, **_kwargs: "fake-token",
        build_proxies=lambda *_args, **_kwargs: {},
        download_video_to_file=lambda *_args, **_kwargs: None,
        call_litellm_chat=_call_litellm_chat,
        extract_chat_content=_extract_chat_content,
        try_parse_json_object=_try_parse_json_object,
    )
    with app.test_client() as client:
        yield client, llm_state


class TestHotVideoAnalyzeApi:
    endpoint = "/api/hot-video/remake/analyze"

    def test_returns_vertex_analysis_payload(self, monkeypatch, hot_video_client):
        client, _llm_state = hot_video_client
        from shoplive.backend.api import hot_video_api as mod
        import requests

        monkeypatch.setattr(
            mod,
            "_run_video_asr",
            lambda *args, **kwargs: {
                "ok": True,
                "subtitles": [{"start": 0.0, "end": 2.0, "text": "前三秒抛出钩子"}],
                "raw_text": "[0.0-2.0] 前三秒抛出钩子",
                "cached": False,
                "resolved_video_url": "https://cdn.example.com/video.mp4",
                "resolved_page_url": "https://www.douyin.com/video/123",
                "share_resolution": {
                    "input_url": "https://v.douyin.com/abc/",
                    "resolved_video_url": "https://cdn.example.com/video.mp4",
                    "resolved_page_url": "https://www.douyin.com/video/123",
                    "strategy": "html_extract",
                },
            },
        )
        monkeypatch.setattr(
            requests,
            "post",
            lambda *args, **kwargs: _VertexResp(
                {
                    "candidates": [{
                        "content": {
                            "parts": [{
                                "text": json.dumps(
                                    {
                                        "summary": "这是一条高转化参考视频。",
                                        "hook": "前三秒直接展示结果",
                                        "structure": [{"title": "钩子", "summary": "先抛结果", "beats": ["结果先行"]}],
                                        "shot_plan": [{"shot": "镜头1", "duration_seconds": 4, "visual": "近景展示", "voiceover": "直接上结果", "onscreen_text": "先看效果"}],
                                        "voiceover_script": "直接上结果，再解释原因。",
                                        "remake_script": "[脚本 A]\n镜头1：直接上结果。",
                                        "remake_prompt": "hero video prompt",
                                        "analysis_notes": "保留节奏，替换商品。",
                                    },
                                    ensure_ascii=False,
                                )
                            }]
                        }
                    }]
                }
            ),
        )

        resp = client.post(
            self.endpoint,
            json={
                "video_url": "https://v.douyin.com/abc/",
                "language": "zh",
                "product_name": "测试商品",
                "selling_points": "卖点1,卖点2",
            },
        )
        assert resp.status_code == 200
        data = resp.get_json()
        assert data["ok"] is True
        assert data["source"] == "vertex"
        assert data["summary"] == "这是一条高转化参考视频。"
        assert data["resolved_video_url"] == "https://cdn.example.com/video.mp4"
        assert data["share_resolution"]["strategy"] == "html_extract"
        assert data["remake_prompt"] == "hero video prompt"

    def test_falls_back_when_vertex_analysis_fails(self, monkeypatch, hot_video_client):
        client, _llm_state = hot_video_client
        from shoplive.backend.api import hot_video_api as mod
        import requests

        monkeypatch.setattr(
            mod,
            "_run_video_asr",
            lambda *args, **kwargs: {
                "ok": True,
                "subtitles": [{"start": 0.0, "end": 2.0, "text": "耳机音质更沉浸"}],
                "raw_text": "[0.0-2.0] 耳机音质更沉浸",
                "cached": False,
                "resolved_video_url": "https://sns-video-bd.xhscdn.com/test.mp4",
                "resolved_page_url": "https://www.xiaohongshu.com/explore/demo",
                "share_resolution": {
                    "input_url": "https://xhslink.com/demo",
                    "resolved_video_url": "https://sns-video-bd.xhscdn.com/test.mp4",
                    "resolved_page_url": "https://www.xiaohongshu.com/explore/demo",
                    "strategy": "html_extract",
                },
            },
        )
        monkeypatch.setattr(
            requests,
            "post",
            lambda *args, **kwargs: (_ for _ in ()).throw(RuntimeError("vertex unavailable")),
        )

        resp = client.post(
            self.endpoint,
            json={
                "video_url": "https://xhslink.com/demo",
                "language": "zh",
                "product_name": "测试连衣裙",
                "selling_points": "显瘦版型,轻盈面料",
                "duration": 16,
            },
        )
        assert resp.status_code == 200
        data = resp.get_json()
        assert data["ok"] is True
        assert data["source"] == "fallback"
        assert "测试连衣裙" in data["remake_prompt"]
        assert data["share_resolution"]["strategy"] == "html_extract"
        assert data["resolved_page_url"] == "https://www.xiaohongshu.com/explore/demo"

    def test_fallback_keeps_share_resolution_when_asr_stage_fails(self, monkeypatch, hot_video_client):
        client, _llm_state = hot_video_client
        from shoplive.backend.api import hot_video_api as mod
        import requests

        monkeypatch.setattr(
            mod,
            "_run_video_asr",
            lambda *args, **kwargs: {
                "ok": False,
                "subtitles": [],
                "raw_text": "",
                "cached": False,
                "asr_error": "connection reset",
                "resolved_video_url": "https://aweme.snssdk.com/aweme/v1/play/?video_id=demo123",
                "resolved_page_url": "https://www.iesdouyin.com/share/video/123",
                "share_resolution": {
                    "input_url": "https://v.douyin.com/demo",
                    "resolved_video_url": "https://aweme.snssdk.com/aweme/v1/play/?video_id=demo123",
                    "resolved_page_url": "https://www.iesdouyin.com/share/video/123",
                    "strategy": "html_extract",
                },
            },
        )
        monkeypatch.setattr(
            requests,
            "post",
            lambda *args, **kwargs: (_ for _ in ()).throw(RuntimeError("vertex unavailable")),
        )

        resp = client.post(
            self.endpoint,
            json={
                "video_url": "https://v.douyin.com/demo",
                "language": "zh",
                "product_name": "测试商品",
            },
        )
        assert resp.status_code == 200
        data = resp.get_json()
        assert data["ok"] is True
        assert data["source"] == "fallback"
        assert data["asr_error"] == "connection reset"
        assert data["share_resolution"]["strategy"] == "html_extract"
        assert data["resolved_page_url"] == "https://www.iesdouyin.com/share/video/123"

    def test_validation_rejects_invalid_video_url(self, hot_video_client):
        client, _llm_state = hot_video_client
        resp = client.post(self.endpoint, json={"video_url": "not-a-url"})
        assert resp.status_code == 400
        data = resp.get_json()
        assert data["ok"] is False
        assert data["error_code"] == "VALIDATION_ERROR"

    def test_validation_accepts_share_text_with_embedded_url(self, monkeypatch, hot_video_client):
        client, _llm_state = hot_video_client
        from shoplive.backend.api import hot_video_api as mod
        import requests

        captured = {}

        def _fake_asr(payload, **_kwargs):
            captured["video_url"] = payload.get("video_url")
            return {
                "ok": True,
                "subtitles": [{"start": 0.0, "end": 2.0, "text": "开头给钩子"}],
                "raw_text": "[0.0-2.0] 开头给钩子",
                "cached": False,
                "resolved_video_url": "https://cdn.example.com/play.mp4",
                "resolved_page_url": "https://www.douyin.com/video/123",
                "share_resolution": {"strategy": "html_extract"},
            }

        monkeypatch.setattr(mod, "_run_video_asr", _fake_asr)
        monkeypatch.setattr(
            requests,
            "post",
            lambda *args, **kwargs: _VertexResp(
                {"candidates": [{"content": {"parts": [{"text": "{}"}]}}]}
            ),
        )
        resp = client.post(
            self.endpoint,
            json={
                "video_url": "打开抖音，看看【作者】的视频 https://v.douyin.com/abc123/ 复制此链接，打开Dou音搜索，直接观看视频！",
                "language": "zh",
                "product_name": "测试商品",
            },
        )
        assert resp.status_code == 200
        assert captured["video_url"] == "https://v.douyin.com/abc123/"


def test_run_video_asr_returns_400_when_share_link_unresolved():
    from shoplive.backend.api.hot_video_api import _run_video_asr

    called = {"download": False}

    def _json_error(message, status=400, **extra):
        payload = {"ok": False, "error": message}
        payload.update(extra)
        return payload, status

    result = _run_video_asr(
        {"video_url": "https://xhslink.com/unresolved", "language": "zh"},
        json_error=_json_error,
        parse_common_payload=lambda payload: ("demo-project", "/tmp/fake-key.json", payload.get("proxy", ""), payload.get("model", "")),
        get_access_token=lambda *_args, **_kwargs: "fake-token",
        build_proxies=lambda *_args, **_kwargs: {},
        download_video_to_file=lambda *_args, **_kwargs: called.__setitem__("download", True),
        resolve_share_url=lambda *_args, **_kwargs: {
            "input_url": "https://xhslink.com/unresolved",
            "resolved_video_url": "https://www.xiaohongshu.com/explore/demo",
            "resolved_page_url": "https://www.xiaohongshu.com/explore/demo",
            "strategy": "unresolved_page",
        },
    )

    assert isinstance(result, tuple)
    payload, status = result
    assert status == 400
    assert payload["ok"] is False
    assert "未解析到可下载的视频直链" in payload["error"]
    assert called["download"] is False


def test_run_video_asr_preserves_share_resolution_when_download_fails():
    from shoplive.backend.api.hot_video_api import _run_video_asr

    result = _run_video_asr(
        {"video_url": "https://v.douyin.com/abc123/", "language": "zh"},
        json_error=lambda message, status=400, **extra: ({"ok": False, "error": message, **extra}, status),
        parse_common_payload=lambda payload: ("demo-project", "/tmp/fake-key.json", payload.get("proxy", ""), payload.get("model", "")),
        get_access_token=lambda *_args, **_kwargs: "fake-token",
        build_proxies=lambda *_args, **_kwargs: {},
        download_video_to_file=lambda *_args, **_kwargs: (_ for _ in ()).throw(ConnectionResetError("connection reset")),
        resolve_share_url=lambda *_args, **_kwargs: {
            "input_url": "https://v.douyin.com/abc123/",
            "resolved_video_url": "https://aweme.snssdk.com/aweme/v1/play/?video_id=demo123",
            "resolved_page_url": "https://www.iesdouyin.com/share/video/123",
            "strategy": "html_extract",
        },
    )

    assert isinstance(result, dict)
    assert result["ok"] is False
    assert "connection reset" in result["asr_error"]
    assert result["resolved_video_url"] == "https://aweme.snssdk.com/aweme/v1/play/?video_id=demo123"
    assert result["resolved_page_url"] == "https://www.iesdouyin.com/share/video/123"
    assert result["share_resolution"]["strategy"] == "html_extract"
