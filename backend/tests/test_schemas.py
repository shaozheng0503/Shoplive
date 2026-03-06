"""
Tests for backend/schemas.py — Pydantic request schema validation.

Verifies that each schema accepts valid input and rejects invalid input
with meaningful errors, per "一文读懂 Agent Tools" type-safety principle.
"""
import pytest
from pydantic import ValidationError

from shoplive.backend.schemas import (
    AgentChatRequest,
    ImageInsightRequest,
    ProductInsightRequest,
    VideoTimelineRenderRequest,
    VeoChainRequest,
    VeoExtendRequest,
    VeoStartRequest,
    VeoStatusRequest,
    VideoWorkflowRequest,
    TOOL_SCHEMAS,
)


# ---------------------------------------------------------------------------
# ProductInsightRequest
# ---------------------------------------------------------------------------

class TestProductInsightRequest:
    def test_valid_http_url(self):
        req = ProductInsightRequest(product_url="https://www.amazon.com/dp/B0TEST")
        assert req.product_url == "https://www.amazon.com/dp/B0TEST"
        assert req.language == "zh"   # default
        assert req.proxy == ""         # default

    def test_valid_http_url_lowercase(self):
        req = ProductInsightRequest(product_url="http://item.taobao.com/item.htm?id=123")
        assert req.product_url.startswith("http://")

    def test_strips_whitespace_from_url(self):
        req = ProductInsightRequest(product_url="  https://www.amazon.com/dp/B0X  ")
        assert req.product_url == "https://www.amazon.com/dp/B0X"

    def test_language_en_accepted(self):
        req = ProductInsightRequest(product_url="https://a.com", language="en")
        assert req.language == "en"

    def test_language_invalid_rejected(self):
        with pytest.raises(ValidationError) as exc_info:
            ProductInsightRequest(product_url="https://a.com", language="fr")
        errors = exc_info.value.errors(include_url=False)
        assert any(e["loc"] == ("language",) for e in errors)

    def test_missing_product_url_rejected(self):
        with pytest.raises(ValidationError) as exc_info:
            ProductInsightRequest()
        errors = exc_info.value.errors(include_url=False)
        assert any("product_url" in str(e["loc"]) for e in errors)

    def test_invalid_url_no_protocol_rejected(self):
        with pytest.raises(ValidationError):
            ProductInsightRequest(product_url="www.amazon.com/dp/B0TEST")

    def test_empty_url_rejected(self):
        with pytest.raises(ValidationError):
            ProductInsightRequest(product_url="")


# ---------------------------------------------------------------------------
# ImageInsightRequest
# ---------------------------------------------------------------------------

class TestImageInsightRequest:
    def test_defaults(self):
        req = ImageInsightRequest()
        assert req.model == "gemini-2.5-flash"
        assert req.language == "zh"
        assert req.image_mime_type == "image/jpeg"
        assert req.image_items is None
        assert req.image_base64 == ""
        assert req.image_url == ""

    def test_valid_mime_type_png(self):
        req = ImageInsightRequest(image_mime_type="image/png")
        assert req.image_mime_type == "image/png"

    def test_invalid_mime_type_rejected(self):
        with pytest.raises(ValidationError) as exc_info:
            ImageInsightRequest(image_mime_type="image/gif")
        errors = exc_info.value.errors(include_url=False)
        assert any("image_mime_type" in str(e["loc"]) for e in errors)

    def test_inherits_common_payload_defaults(self):
        req = ImageInsightRequest()
        assert req.project_id == "gemini-sl-20251120"
        assert req.key_file == ""
        assert req.proxy == ""


# ---------------------------------------------------------------------------
# AgentChatRequest
# ---------------------------------------------------------------------------

class TestAgentChatRequest:
    def test_all_defaults(self):
        req = AgentChatRequest()
        assert req.api_base == ""
        assert req.api_key == ""
        assert req.model == ""
        assert req.messages is None
        assert req.prompt == ""
        assert req.temperature is None
        assert req.max_tokens is None
        assert req.top_p is None
        assert req.stream is False

    def test_with_prompt(self):
        req = AgentChatRequest(prompt="Tell me about this product", model="azure-gpt-5")
        assert req.prompt == "Tell me about this product"
        assert req.model == "azure-gpt-5"

    def test_with_messages(self):
        msgs = [{"role": "user", "content": "Hi"}]
        req = AgentChatRequest(messages=msgs, api_key="sk-test")
        assert req.messages == msgs
        assert req.api_key == "sk-test"

    def test_temperature_bounds(self):
        req = AgentChatRequest(temperature=0.7)
        assert req.temperature == 0.7

    def test_temperature_none_allowed(self):
        req = AgentChatRequest(temperature=None)
        assert req.temperature is None

    def test_stream_true_allowed(self):
        req = AgentChatRequest(prompt="optimize this prompt", stream=True)
        assert req.stream is True


# ---------------------------------------------------------------------------
# VeoStartRequest
# ---------------------------------------------------------------------------

class TestVeoStartRequest:
    def test_required_prompt(self):
        with pytest.raises(ValidationError) as exc_info:
            VeoStartRequest()  # prompt is required
        errors = exc_info.value.errors(include_url=False)
        assert any("prompt" in str(e["loc"]) for e in errors)

    def test_valid_text_mode(self):
        req = VeoStartRequest(prompt="A model in a garden")
        assert req.veo_mode == "text"
        assert req.model == "veo-3.1-generate-preview"
        assert req.sample_count == 1
        assert req.duration_seconds is None

    def test_veo_mode_image_accepted(self):
        req = VeoStartRequest(prompt="test", veo_mode="image")
        assert req.veo_mode == "image"

    def test_veo_mode_reference_accepted(self):
        req = VeoStartRequest(prompt="test", veo_mode="reference")
        assert req.veo_mode == "reference"

    def test_invalid_veo_mode_rejected(self):
        with pytest.raises(ValidationError) as exc_info:
            VeoStartRequest(prompt="test", veo_mode="video")
        errors = exc_info.value.errors(include_url=False)
        assert any("veo_mode" in str(e["loc"]) for e in errors)

    def test_sample_count_bounds(self):
        req = VeoStartRequest(prompt="test", sample_count=4)
        assert req.sample_count == 4
        with pytest.raises(ValidationError):
            VeoStartRequest(prompt="test", sample_count=5)
        with pytest.raises(ValidationError):
            VeoStartRequest(prompt="test", sample_count=0)

    def test_valid_duration_seconds(self):
        for d in (4, 6, 8):
            req = VeoStartRequest(prompt="test", duration_seconds=d)
            assert req.duration_seconds == d

    def test_invalid_duration_seconds(self):
        with pytest.raises(ValidationError):
            VeoStartRequest(prompt="test", duration_seconds=5)

    def test_invalid_mime_type_rejected(self):
        with pytest.raises(ValidationError):
            VeoStartRequest(prompt="test", image_mime_type="image/bmp")


# ---------------------------------------------------------------------------
# VeoStatusRequest
# ---------------------------------------------------------------------------

class TestVeoStatusRequest:
    def test_required_operation_name(self):
        with pytest.raises(ValidationError):
            VeoStatusRequest()  # operation_name is required

    def test_valid_request(self):
        req = VeoStatusRequest(
            operation_name="projects/my-proj/locations/us-central1/operations/abc123"
        )
        assert "abc123" in req.operation_name
        assert req.model == "veo-3.1-generate-preview"

    def test_inherits_common_defaults(self):
        req = VeoStatusRequest(operation_name="op-name")
        assert req.project_id == "gemini-sl-20251120"


# ---------------------------------------------------------------------------
# VeoChainRequest
# ---------------------------------------------------------------------------

class TestVeoChainRequest:
    def test_required_fields(self):
        with pytest.raises(ValidationError):
            VeoChainRequest()  # prompt + storage_uri required

    def test_valid_chain_request(self):
        req = VeoChainRequest(
            prompt="Product showcase",
            storage_uri="gs://my-bucket/videos/",
            target_total_seconds=16,
        )
        assert req.target_total_seconds == 16
        assert req.extend_retry_max == 1  # default

    def test_invalid_target_total_seconds(self):
        with pytest.raises(ValidationError):
            VeoChainRequest(prompt="test", storage_uri="gs://b/", target_total_seconds=12)

    def test_poll_interval_bounds(self):
        with pytest.raises(ValidationError):
            VeoChainRequest(prompt="t", storage_uri="gs://b/", poll_interval_seconds=0)
        with pytest.raises(ValidationError):
            VeoChainRequest(prompt="t", storage_uri="gs://b/", poll_interval_seconds=31)


# ---------------------------------------------------------------------------
# VideoWorkflowRequest
# ---------------------------------------------------------------------------

class TestVideoWorkflowRequest:
    def test_default_action(self):
        req = VideoWorkflowRequest()
        assert req.action == "generate_script"
        assert req.input == {}

    def test_valid_actions(self):
        for action in ("validate", "generate_script", "pre_export_check",
                       "build_export_prompt", "build_enhance_template"):
            req = VideoWorkflowRequest(action=action)
            assert req.action == action

    def test_invalid_action_rejected(self):
        with pytest.raises(ValidationError):
            VideoWorkflowRequest(action="unknown_step")


# ---------------------------------------------------------------------------
# VideoTimelineRenderRequest
# ---------------------------------------------------------------------------

class TestVideoTimelineRenderRequest:
    def test_valid_minimal_request(self):
        req = VideoTimelineRenderRequest(
            source_video_url="https://example.com/video.mp4",
            tracks=[
                {
                    "label": "Video",
                    "track_type": "video",
                    "segments": [{"id": "s1", "left": 0, "width": 50}],
                }
            ],
        )
        assert req.source_video_url.startswith("https://")
        assert req.include_audio is True
        assert req.segment_sort_strategy == "track_then_start"
        assert req.async_job is False
        assert len(req.tracks) == 1

    def test_data_url_source_allowed(self):
        req = VideoTimelineRenderRequest(
            source_video_url="data:video/mp4;base64,AAAA",
            tracks=[{"label": "Video", "segments": [{"left": 0, "width": 100}]}],
        )
        assert req.source_video_url.startswith("data:video/")

    def test_invalid_source_rejected(self):
        with pytest.raises(ValidationError):
            VideoTimelineRenderRequest(
                source_video_url="file:///tmp/a.mp4",
                tracks=[{"label": "Video", "segments": [{"left": 0, "width": 100}]}],
            )

    def test_empty_tracks_rejected(self):
        with pytest.raises(ValidationError):
            VideoTimelineRenderRequest(source_video_url="https://example.com/video.mp4", tracks=[])

    def test_end_seconds_must_be_after_start(self):
        with pytest.raises(ValidationError):
            VideoTimelineRenderRequest(
                source_video_url="https://example.com/video.mp4",
                tracks=[
                    {
                        "label": "Video",
                        "segments": [{"start_seconds": 3, "end_seconds": 2}],
                    }
                ],
            )

    def test_sort_strategy_literal(self):
        req = VideoTimelineRenderRequest(
            source_video_url="https://example.com/video.mp4",
            segment_sort_strategy="start_then_track",
            async_job=True,
            tracks=[{"label": "Video", "segments": [{"left": 0, "width": 100}]}],
        )
        assert req.segment_sort_strategy == "start_then_track"
        assert req.async_job is True

    def test_invalid_sort_strategy_rejected(self):
        with pytest.raises(ValidationError):
            VideoTimelineRenderRequest(
                source_video_url="https://example.com/video.mp4",
                segment_sort_strategy="custom",
                tracks=[{"label": "Video", "segments": [{"left": 0, "width": 100}]}],
            )


# ---------------------------------------------------------------------------
# TOOL_SCHEMAS registry
# ---------------------------------------------------------------------------

class TestToolSchemasRegistry:
    def test_all_expected_tools_present(self):
        expected = {
            "parse_product_url",
            "analyze_product_image",
            "chat_with_llm",
            "run_video_workflow",
            "generate_video",
            "chain_video_segments",
            "check_video_status",
            "extend_video",
            "export_edited_video",
            "render_video_timeline",
            "generate_product_image",
        }
        assert expected == set(TOOL_SCHEMAS.keys())

    def test_schema_classes_are_pydantic_models(self):
        from pydantic import BaseModel
        for name, cls in TOOL_SCHEMAS.items():
            assert issubclass(cls, BaseModel), f"{name} schema must be a Pydantic BaseModel"

    def test_schemas_produce_json_schema(self):
        for name, cls in TOOL_SCHEMAS.items():
            schema = cls.model_json_schema()
            assert "properties" in schema or "type" in schema, \
                f"{name} schema failed model_json_schema()"
