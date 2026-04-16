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

    # Control LLM behaviour per-test: set "raise" to an exception to simulate failure,
    # or set "response" to control what call_litellm_chat returns.
    llm_state = {
        "response": (200, {"ok": True, "response": {"choices": [{"message": {"content": "{}"}}]}}),
        "raise": None,
    }

    def _json_error(message, status=400, **extra):
        payload = {"ok": False, "error": message}
        payload.update(extra)
        return jsonify(payload), status

    def _call_litellm_chat(**_kwargs):
        if llm_state.get("raise"):
            raise llm_state["raise"]
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
        client, llm_state = hot_video_client
        from shoplive.backend.api import hot_video_api as mod

        analysis_json = {
            "summary": "这是一条高转化参考视频。",
            "hook": "前三秒直接展示结果",
            "structure": [{"title": "钩子", "summary": "先抛结果", "beats": ["结果先行"]}],
            "shot_plan": [{"shot": "镜头1", "duration_seconds": 4, "visual": "近景展示", "voiceover": "直接上结果", "onscreen_text": "先看效果"}],
            "voiceover_script": "直接上结果，再解释原因。",
            "remake_script": "[脚本 A]\n镜头1：直接上结果。",
            "remake_prompt": "hero video prompt",
            "analysis_notes": "",
        }
        llm_state["response"] = (200, {"ok": True, "response": {"choices": [{"message": {"content": json.dumps(analysis_json, ensure_ascii=False)}}]}})

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
        assert data["source"] == "litellm"
        assert data["summary"] == "这是一条高转化参考视频。"
        assert data["resolved_video_url"] == "https://cdn.example.com/video.mp4"
        assert data["share_resolution"]["strategy"] == "html_extract"
        assert data["remake_prompt"] == "hero video prompt"
        # New fields: engine_prompts, confidence_score, shot_count, subtitle_count
        assert "engine_prompts" in data
        assert isinstance(data["engine_prompts"], dict)
        assert "veo" in data["engine_prompts"]
        assert "jimeng" in data["engine_prompts"]
        assert "ltx" in data["engine_prompts"]
        assert "grok" in data["engine_prompts"]
        assert "confidence_score" in data
        assert 0.0 <= data["confidence_score"] <= 1.0
        assert data["shot_count"] == 1
        assert data["subtitle_count"] == 1

    def test_falls_back_when_vertex_analysis_fails(self, monkeypatch, hot_video_client):
        client, llm_state = hot_video_client
        from shoplive.backend.api import hot_video_api as mod

        llm_state["raise"] = RuntimeError("vertex unavailable")

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
        client, llm_state = hot_video_client
        from shoplive.backend.api import hot_video_api as mod

        llm_state["raise"] = RuntimeError("llm unavailable")

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


# ── New feature tests ────────────────────────────────────────────────────────

class TestCleanSubtitleText:
    def test_strips_music_tag(self):
        from shoplive.backend.api.hot_video_api import _clean_subtitle_text
        assert _clean_subtitle_text("[music] 这件衣服显瘦") == "这件衣服显瘦"

    def test_strips_background_music_zh(self):
        from shoplive.backend.api.hot_video_api import _clean_subtitle_text
        assert _clean_subtitle_text("[背景音乐] 欢迎来购") == "欢迎来购"

    def test_strips_applause(self):
        from shoplive.backend.api.hot_video_api import _clean_subtitle_text
        assert _clean_subtitle_text("[applause] Great product!") == "Great product!"

    def test_returns_empty_when_only_noise(self):
        from shoplive.backend.api.hot_video_api import _clean_subtitle_text
        assert _clean_subtitle_text("[music]") == ""

    def test_passes_through_clean_text(self):
        from shoplive.backend.api.hot_video_api import _clean_subtitle_text
        assert _clean_subtitle_text("三秒钩子直接给结果") == "三秒钩子直接给结果"

    def test_collapses_extra_spaces(self):
        from shoplive.backend.api.hot_video_api import _clean_subtitle_text
        result = _clean_subtitle_text("你好  世界")
        assert result == "你好 世界"


class TestComputeConfidenceScore:
    def test_litellm_with_rich_subtitles(self):
        from shoplive.backend.api.hot_video_api import _compute_confidence_score
        subtitles = [{"start": i, "end": i + 1, "text": f"line{i}"} for i in range(12)]
        shot_plan = [{"shot": f"s{i}"} for i in range(6)]
        score = _compute_confidence_score("litellm", subtitles, shot_plan)
        assert 0.9 <= score <= 1.0

    def test_fallback_with_no_subtitles(self):
        from shoplive.backend.api.hot_video_api import _compute_confidence_score
        score = _compute_confidence_score("fallback", [], [])
        assert score == 0.25

    def test_litellm_empty_mid_range(self):
        from shoplive.backend.api.hot_video_api import _compute_confidence_score
        score = _compute_confidence_score("litellm_empty", [], [])
        assert 0.4 <= score <= 0.6

    def test_score_bounded_0_to_1(self):
        from shoplive.backend.api.hot_video_api import _compute_confidence_score
        subtitles = [{"start": i, "end": i + 1, "text": f"line{i}"} for i in range(50)]
        shot_plan = [{"shot": f"s{i}"} for i in range(20)]
        score = _compute_confidence_score("litellm", subtitles, shot_plan)
        assert 0.0 <= score <= 1.0


class TestBuildEnginePrompts:
    def test_returns_all_four_engines(self):
        from shoplive.backend.api.hot_video_api import _build_engine_prompts
        prompts = _build_engine_prompts("base prompt", {"hook": "先看结果"}, {"language": "zh", "product_name": "连衣裙", "duration": 16})
        assert set(prompts.keys()) == {"veo", "jimeng", "ltx", "grok"}

    def test_engine_prompts_non_empty(self):
        from shoplive.backend.api.hot_video_api import _build_engine_prompts
        prompts = _build_engine_prompts("hero video", {}, {"language": "en", "product_name": "dress", "duration": 12})
        for engine, text in prompts.items():
            assert len(text) > 10, f"Engine {engine} prompt too short: {repr(text)}"

    def test_veo_contains_cinematic_keywords(self):
        from shoplive.backend.api.hot_video_api import _build_engine_prompts
        prompts = _build_engine_prompts("base", {}, {"language": "en", "product_name": "dress", "duration": 16})
        assert any(k in prompts["veo"].lower() for k in ["cinematic", "camera", "lighting"])

    def test_ltx_contains_keyframe_keyword(self):
        from shoplive.backend.api.hot_video_api import _build_engine_prompts
        prompts = _build_engine_prompts("base", {}, {"language": "en", "product_name": "dress", "duration": 16})
        assert "keyframe" in prompts["ltx"].lower()

    def test_jimeng_zh_contains_chinese_quality_words(self):
        from shoplive.backend.api.hot_video_api import _build_engine_prompts
        prompts = _build_engine_prompts("基础提示词", {}, {"language": "zh", "product_name": "连衣裙", "duration": 16})
        assert any(k in prompts["jimeng"] for k in ["高清", "通透", "暖调", "质感"])

    def test_fallback_base_uses_context_if_empty(self):
        from shoplive.backend.api.hot_video_api import _build_engine_prompts
        prompts = _build_engine_prompts("", {}, {"language": "en", "product_name": "shirt", "duration": 8})
        assert "shirt" in prompts["veo"]


class TestAnalysisMessagesEngineStyle:
    def test_veo_engine_style_in_system_prompt(self):
        from shoplive.backend.api.hot_video_api import _build_analysis_messages
        messages = _build_analysis_messages(
            {"language": "zh", "video_engine": "veo", "duration": 16},
            [],
            ""
        )
        system_content = messages[0]["content"]
        assert "veo" in system_content.lower()
        assert "摄像机" in system_content or "电影" in system_content

    def test_jimeng_engine_style_in_system_prompt(self):
        from shoplive.backend.api.hot_video_api import _build_analysis_messages
        messages = _build_analysis_messages(
            {"language": "zh", "video_engine": "jimeng", "duration": 16},
            [],
            ""
        )
        system_content = messages[0]["content"]
        assert "jimeng" in system_content.lower()
        assert "美学" in system_content or "色调" in system_content

    def test_product_anchors_woven_into_prompt_instructions(self):
        from shoplive.backend.api.hot_video_api import _build_analysis_messages
        messages = _build_analysis_messages(
            {"language": "zh", "video_engine": "veo", "product_anchors": {"colors": ["红色"], "materials": ["棉麻"]}, "duration": 16},
            [],
            ""
        )
        system_content = messages[0]["content"]
        assert "product_anchors" in system_content or "colors" in system_content or "anchors" in system_content


class TestResponseNewFields:
    """Integration tests verifying new fields appear in API response."""

    def test_engine_prompts_and_confidence_in_response(self, monkeypatch, hot_video_client):
        client, llm_state = hot_video_client
        from shoplive.backend.api import hot_video_api as mod

        analysis_json = {
            "summary": "高转化视频。",
            "hook": "3秒钩子",
            "structure": [],
            "shot_plan": [
                {"shot": "镜头1", "duration_seconds": 5, "visual": "近景", "voiceover": "文案", "onscreen_text": "字幕"},
                {"shot": "镜头2", "duration_seconds": 5, "visual": "中景", "voiceover": "文案2", "onscreen_text": ""},
            ],
            "voiceover_script": "全文",
            "remake_script": "脚本",
            "remake_prompt": "engine prompt",
            "analysis_notes": "",
        }
        llm_state["response"] = (200, {"ok": True, "response": {"choices": [{"message": {"content": json.dumps(analysis_json, ensure_ascii=False)}}]}})

        monkeypatch.setattr(mod, "_run_video_asr", lambda *a, **kw: {
            "ok": True,
            "subtitles": [{"start": i, "end": i + 1, "text": f"字幕{i}"} for i in range(8)],
            "raw_text": "transcript",
            "subtitle_count": 8,
            "asr_duration": 8.0,
            "cached": False,
            "resolved_video_url": "https://cdn.example.com/v.mp4",
            "resolved_page_url": "https://douyin.com/v/123",
            "share_resolution": {"strategy": "html_extract"},
        })

        resp = client.post(self.endpoint, json={
            "video_url": "https://v.douyin.com/abc/",
            "language": "zh",
            "product_name": "连衣裙",
            "video_engine": "jimeng",
        })
        assert resp.status_code == 200
        data = resp.get_json()
        assert data["ok"] is True
        assert data["shot_count"] == 2
        assert data["total_shot_duration"] == 10
        assert data["subtitle_count"] == 8
        assert 0.0 <= data["confidence_score"] <= 1.0
        assert isinstance(data["engine_prompts"], dict)
        assert all(k in data["engine_prompts"] for k in ("veo", "jimeng", "ltx", "grok"))

    endpoint = "/api/hot-video/remake/analyze"

    def test_fallback_also_has_engine_prompts(self, monkeypatch, hot_video_client):
        client, llm_state = hot_video_client
        from shoplive.backend.api import hot_video_api as mod

        llm_state["raise"] = RuntimeError("llm down")
        monkeypatch.setattr(mod, "_run_video_asr", lambda *a, **kw: {
            "ok": False,
            "subtitles": [],
            "raw_text": "",
            "cached": False,
            "asr_error": "download failed",
            "resolved_video_url": "https://cdn.example.com/v.mp4",
            "resolved_page_url": "https://douyin.com/v/123",
            "share_resolution": {"strategy": "html_extract"},
        })

        resp = client.post(self.endpoint, json={
            "video_url": "https://v.douyin.com/abc/",
            "language": "zh",
            "product_name": "运动鞋",
        })
        assert resp.status_code == 200
        data = resp.get_json()
        assert data["source"] == "fallback"
        assert isinstance(data["engine_prompts"], dict)
        assert len(data["engine_prompts"]) == 4
        # Fallback base is 0.25; fallback shot plan has 3 shots (+0.051) → ~0.30
        assert data["confidence_score"] <= 0.35
