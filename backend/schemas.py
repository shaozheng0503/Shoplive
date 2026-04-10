"""
Pydantic schemas for Shoplive API request validation.

Design principles (from "一文读懂 Agent Tools"):
- Use Pydantic BaseModel for automatic schema generation and data validation
- Limit enum values via Literal to reduce model error probability
- Set clear defaults to lighten model burden
- Use natural language Field descriptions so LLM understands how to fill parameters
"""

import re
from typing import Any, Dict, List, Literal, Optional
from urllib.parse import urlparse

from pydantic import BaseModel, Field, field_validator


def _extract_http_url_candidate(raw: str) -> str:
    s = (
        str(raw or "")
        .replace("\ufeff", "")
        .replace("\u200b", "")
        .replace("\u201c", "")
        .replace("\u201d", "")
        .replace("\u2018", "")
        .replace("\u2019", "")
        .strip()
    )
    if not s:
        return ""
    patterns = [
        r"https?:\/\/[^\s<>\"'`]+",
        r"\bwww\.[a-z0-9.-]+\.[a-z]{2,}[^\s<>\"'`]*",
        r"\b[a-z0-9][a-z0-9.-]*\.[a-z]{2,}(?:\/[^\s<>\"'`]*)?",
    ]
    for pattern in patterns:
        match = re.search(pattern, s, re.IGNORECASE)
        if match:
            return str(match.group(0)).rstrip("),.;，。!！")
    return ""


# ---------------------------------------------------------------------------
# Common / Shared
# ---------------------------------------------------------------------------

class CommonPayload(BaseModel):
    """Google Cloud common authentication and project fields."""
    project_id: str = Field(
        default="qy-shoplazza-02",
        description="Google Cloud project ID. Use the default unless you have a custom project.",
    )
    key_file: str = Field(
        default="",
        description="Path to the service account JSON key file. "
                    "Leave empty to auto-discover from GOOGLE_APPLICATION_CREDENTIALS or default paths.",
    )
    proxy: str = Field(
        default="",
        description="HTTP proxy URL. Leave empty for auto-detection (env vars or local proxy). "
                    "Example: 'http://127.0.0.1:7890'",
    )
    model: str = Field(
        default="",
        description="Model name to use. Each API has its own default if left empty.",
    )


# ---------------------------------------------------------------------------
# Agent APIs
# ---------------------------------------------------------------------------

class ProductInsightRequest(BaseModel):
    """Parse a product URL from e-commerce platforms to extract product information.

    Supported platforms: Amazon, Shein, Taobao, JD, Temu, Aliexpress,
    TikTok Shop, Etsy, Ebay, Walmart, Shopify, Shoplazza, and generic sites.

    Example:
        {"product_url": "https://www.amazon.com/dp/B0XXXXXX", "language": "en"}
    """
    product_url: str = Field(
        description="Full product page URL starting with http:// or https://. "
                    "Example: 'https://www.amazon.com/dp/B0XXXXXX'"
    )
    proxy: str = Field(
        default="",
        description="HTTP proxy for fetching the product page. Leave empty for auto-detection.",
    )
    language: Literal["zh", "en"] = Field(
        default="zh",
        description="Output language for product insights. 'zh' for Chinese, 'en' for English.",
    )

    @field_validator("product_url")
    @classmethod
    def validate_url(cls, v: str) -> str:
        # Strip BOM / zero-width / line breaks / tabs (paste from sheets, logs, etc.)
        v = (
            str(v or "")
            .strip()
            .replace("\ufeff", "")
            .replace("\u200b", "")
        )
        v = re.sub(r"[\n\r\t\f\v]+", "", v)
        v = v.strip()
        if not v:
            raise ValueError("product_url must be a valid http/https URL")
        if v.startswith("http://") or v.startswith("https://"):
            if not urlparse(v).netloc:
                raise ValueError("product_url must be a valid http/https URL")
            return v
        # No scheme: amazon.com/dp/... , www.amazon.com/... , //amazon.com/...
        candidate = "https://" + v.lstrip("/")
        parsed = urlparse(candidate)
        host = (parsed.netloc or "").lower()
        # Reject only obvious non-URLs; do not use \s here — IDN / rare cases aside, pasted tabs are already stripped.
        if not host or "." not in host or re.search(r"[<>\"']", v):
            raise ValueError("product_url must be a valid http/https URL")
        return candidate


class ImageInsightRequest(CommonPayload):
    """Analyze product images using Gemini to extract product metadata.

    Provide images via one of: image_items, image_base64, or image_url.

    Example:
        {"image_url": "https://example.com/product.jpg", "language": "zh"}
    """
    model: str = Field(
        default="gemini-2.5-flash",
        description="Gemini model for image analysis. Default: gemini-2.5-flash",
    )
    location: str = Field(
        default="global",
        description="Google Cloud region for the Gemini API endpoint.",
    )
    language: Literal["zh", "en"] = Field(
        default="zh",
        description="Output language. 'zh' for Chinese product descriptions, 'en' for English.",
    )
    image_items: Optional[List[Dict[str, str]]] = Field(
        default=None,
        description="List of image objects with 'base64' and 'mime_type' keys. Max 6 images.",
    )
    image_base64: str = Field(
        default="",
        description="Single image as base64 string. Used when image_items is not provided.",
    )
    image_mime_type: Literal["image/png", "image/jpeg"] = Field(
        default="image/jpeg",
        description="MIME type of the image. Only image/png and image/jpeg are supported.",
    )
    image_url: str = Field(
        default="",
        description="URL to fetch the product image from. Used when neither image_items nor image_base64 is provided.",
    )


class AgentChatRequest(BaseModel):
    """General-purpose LLM chat interface.

    Provide either 'messages' (full conversation) or 'prompt' (single user message).

    Example:
        {"prompt": "Summarize the selling points of this product", "model": "azure-gpt-5"}
    """
    api_base: str = Field(
        default="",
        description="LiteLLM API base URL. Falls back to LITELLM_API_BASE env var.",
    )
    api_key: str = Field(
        default="",
        description="LiteLLM API key. Falls back to LITELLM_API_KEY env var. Required.",
    )
    model: str = Field(
        default="",
        description="LLM model name. Falls back to LITELLM_MODEL env var. Default: azure-gpt-5",
    )
    proxy: str = Field(default="", description="HTTP proxy URL.")
    messages: Optional[List[Dict[str, str]]] = Field(
        default=None,
        description="Full conversation history as list of {role, content} objects. "
                    "If not provided, 'prompt' is used to create a single user message.",
    )
    prompt: str = Field(
        default="",
        description="Single user prompt text. Used when 'messages' is not provided.",
    )
    temperature: Optional[float] = Field(
        default=None,
        description="Sampling temperature (0-2). Higher = more creative. Only set when you need specific control.",
    )
    max_tokens: Optional[int] = Field(
        default=None,
        description="Maximum tokens in the response. Only set when you need to limit output length.",
    )
    top_p: Optional[float] = Field(
        default=None,
        description="Nucleus sampling threshold. Only set when you need specific control.",
    )
    stream: bool = Field(
        default=False,
        description="Whether to return Server-Sent Events (SSE) streaming chunks instead of a JSON response.",
    )


# ---------------------------------------------------------------------------
# Shoplive Video Workflow
# ---------------------------------------------------------------------------

class VideoWorkflowRequest(BaseModel):
    """Execute a step in the video creation workflow.

    The workflow follows: validate → generate_script → pre_export_check → build_export_prompt.

    Example:
        {
            "action": "generate_script",
            "input": {
                "product_name": "Summer Floral Dress",
                "selling_points": "Lightweight fabric, floral print, adjustable waist",
                "target_user": "Young women 18-30",
                "sales_region": "US/Europe"
            }
        }
    """
    action: Literal[
        "validate",
        "generate_script",
        "pre_export_check",
        "build_export_prompt",
        "build_enhance_template",
    ] = Field(
        default="generate_script",
        description="Workflow step to execute. "
                    "'validate': Check if the brief is complete. "
                    "'generate_script': Create a video script (requires valid brief). "
                    "'pre_export_check': Verify script before export. "
                    "'build_export_prompt': Generate final Veo-compatible prompt. "
                    "'build_enhance_template': Build template for prompt enhancement.",
    )
    input: Dict[str, Any] = Field(
        default_factory=dict,
        description="Brief input containing product_name, selling_points, target_user, "
                    "sales_region, template, duration, aspect_ratio, etc.",
    )
    api_base: str = Field(default="", description="LiteLLM API base URL.")
    api_key: str = Field(default="", description="LiteLLM API key.")
    model: str = Field(default="", description="LLM model name.")
    proxy: str = Field(default="", description="HTTP proxy URL.")
    user_message: str = Field(
        default="",
        description="Additional user instructions for script generation.",
    )
    script_text: str = Field(
        default="",
        description="Existing script text for pre_export_check or build_export_prompt steps.",
    )
    raw_prompt: str = Field(
        default="",
        description="Raw user prompt for build_enhance_template step.",
    )


# ---------------------------------------------------------------------------
# Hot Video Remake
# ---------------------------------------------------------------------------

class HotVideoRemakeRequest(CommonPayload):
    """Analyze a reference video and return a remake-ready package."""

    video_url: str = Field(
        description="Publicly accessible video URL to analyze. Must start with http:// or https://.",
    )
    language: Literal["zh", "en"] = Field(
        default="zh",
        description="Output language for the analysis package.",
    )
    max_lines: int = Field(
        default=18,
        ge=1,
        le=40,
        description="Maximum subtitle lines to extract during ASR.",
    )
    remake_goal: str = Field(
        default="带货转化",
        description="Goal of the remake, e.g. 带货转化 / 种草 / 品牌展示.",
    )
    product_name: str = Field(
        default="",
        description="Your product name to swap into the remake.",
    )
    main_business: str = Field(
        default="",
        description="Main business/category of your product.",
    )
    selling_points: str = Field(
        default="",
        description="Comma-separated selling points of your own product.",
    )
    target_user: str = Field(
        default="",
        description="Target audience for the remake output.",
    )
    sales_region: str = Field(
        default="",
        description="Sales region for the remake output.",
    )
    brand_direction: str = Field(
        default="",
        description="Brand tone or positioning to preserve in the remake.",
    )
    product_anchors: Dict[str, Any] = Field(
        default_factory=dict,
        description="Structured product anchors such as category, colors, materials, silhouette and key_details.",
    )
    duration: int = Field(
        default=16,
        ge=4,
        le=30,
        description="Target duration in seconds for the remake output.",
    )
    aspect_ratio: Literal["16:9", "9:16", "1:1"] = Field(
        default="16:9",
        description="Target aspect ratio for the remake output.",
    )
    video_engine: Literal["veo", "ltx", "jimeng", "grok"] = Field(
        default="veo",
        description="Target video engine so prompt style can be adapted.",
    )
    api_base: str = Field(default="", description="LiteLLM API base URL.")
    api_key: str = Field(default="", description="LiteLLM API key.")

    @field_validator("video_url")
    @classmethod
    def validate_video_url(cls, v: str) -> str:
        v = (
            str(v or "")
            .strip()
            .replace("\ufeff", "")
            .replace("\u200b", "")
        )
        candidate = _extract_http_url_candidate(v)
        if candidate:
            v = candidate
        v = re.sub(r"[\n\r\t\f\v]+", "", v).strip()
        if not v:
            raise ValueError("video_url must be a valid http/https URL")
        if v.startswith("http://") or v.startswith("https://"):
            if not urlparse(v).netloc:
                raise ValueError("video_url must be a valid http/https URL")
            return v
        candidate = "https://" + v.lstrip("/")
        parsed = urlparse(candidate)
        host = (parsed.netloc or "").lower()
        if not host or "." not in host or re.search(r"[<>\"']", v):
            raise ValueError("video_url must be a valid http/https URL")
        return candidate


# ---------------------------------------------------------------------------
# Agentic Run (Tool-Calling Loop)
# ---------------------------------------------------------------------------

class AgentRunRequest(BaseModel):
    """Run the agent in an agentic tool-calling loop.

    The agent autonomously decides which tools to call based on the conversation.
    Specify ``tools`` to limit which tools are available (defaults to video-editing set).
    Always returns SSE stream of events: start → thinking → tool_call → tool_result → delta → done.

    Example:
        {
            "prompt": "把这个视频加速1.5倍，叠加文字'立即购买'",
            "context": {"video_url": "https://storage.googleapis.com/.../video.mp4"},
            "tools": ["export_edited_video"]
        }
    """
    api_base: str = Field(default="", description="LiteLLM API base URL.")
    api_key: str = Field(default="", description="LiteLLM API key.")
    model: str = Field(default="", description="LLM model. Defaults to LITELLM_MODEL env var.")
    proxy: str = Field(default="", description="HTTP proxy URL.")
    messages: Optional[List[Dict[str, Any]]] = Field(
        default=None,
        description="Full conversation history [{role, content}]. If omitted, 'prompt' is used.",
    )
    prompt: str = Field(
        default="",
        description="Single user instruction. Used when 'messages' is not provided.",
    )
    tools: Optional[List[str]] = Field(
        default=None,
        description="Tool names to enable. None = default video-editing set "
                    "(export_edited_video, render_video_timeline). "
                    "Pass ['*'] to enable all tools.",
    )
    max_rounds: int = Field(
        default=5,
        ge=1,
        le=10,
        description="Maximum tool-call iterations before stopping. Default 5.",
    )
    context: Dict[str, Any] = Field(
        default_factory=dict,
        description="Session context injected into system prompt. "
                    "Common keys: video_url (current video), gcs_uri, model (veo model).",
    )
    temperature: Optional[float] = Field(default=None, description="LLM sampling temperature.")
    max_tokens: Optional[int] = Field(default=None, description="Max tokens in LLM response.")


# ---------------------------------------------------------------------------
# Veo Video Generation
# ---------------------------------------------------------------------------

class VeoStartRequest(CommonPayload):
    """Submit a video generation task to Google Veo.

    Supports four modes:
    - text: Generate video from text prompt only
    - image: Generate video from text + reference image (first frame)
    - reference: Generate video with reference images for style consistency
    - frame: Generate video from first frame + last frame images

    Example:
        {
            "prompt": "A model showcasing a summer dress in a garden...",
            "veo_mode": "text",
            "duration_seconds": 8,
            "aspect_ratio": "16:9"
        }
    """
    model: str = Field(
        default="veo-3.1-generate-preview",
        description="Veo model version. Default: veo-3.1-generate-preview",
    )
    prompt: str = Field(
        description="Video generation prompt. Must be descriptive and include scene, lighting, "
                    "camera work, and action details for best results."
    )
    veo_mode: Literal["text", "image", "reference", "frame"] = Field(
        default="text",
        description="Generation mode. 'text': prompt only. 'image': prompt + first frame image. "
                    "'reference': prompt + reference images for style consistency. "
                    "'frame': prompt + first frame + last frame for controlled transitions.",
    )
    storage_uri: str = Field(
        default="",
        description="GCS URI (gs://bucket/path) for storing generated videos. "
                    "Required for chain mode.",
    )
    sample_count: int = Field(
        default=1,
        ge=1,
        le=4,
        description="Number of video samples to generate (1-4).",
    )
    duration_seconds: Optional[int] = Field(
        default=None,
        ge=4,
        le=15,
        description="Video duration in seconds. Veo supports 4 or 8s; Grok (Aurora) supports 4–15s. "
                    "For single-shot generation without stitching, use 10–15 with a Grok-compatible model.",
    )
    aspect_ratio: Optional[str] = Field(
        default=None,
        description="Video aspect ratio. Common values: '16:9' (landscape), '9:16' (portrait), '1:1' (square).",
    )
    image_url: str = Field(
        default="",
        description="Image URL for 'image' mode. The image serves as the first frame.",
    )
    image_base64: str = Field(
        default="",
        description="Base64-encoded image for 'image' mode.",
    )
    image_mime_type: Literal["image/png", "image/jpeg"] = Field(
        default="image/png",
        description="MIME type of the input image.",
    )
    last_frame_base64: str = Field(
        default="",
        description="Base64-encoded image for the last frame (veo_mode='frame' only).",
    )
    last_frame_mime_type: Literal["image/png", "image/jpeg"] = Field(
        default="image/png",
        description="MIME type of the last frame image.",
    )
    last_frame_url: str = Field(
        default="",
        description="URL of the last frame image (veo_mode='frame' only).",
    )
    negative_prompt: Optional[str] = Field(
        default=None,
        description="What to avoid in the video. Example: 'blurry, text overlay, watermark'",
    )
    person_generation: Optional[str] = Field(
        default=None,
        description="Person generation setting. 'allow_adult' to include people.",
    )
    seed: Optional[int] = Field(
        default=None,
        description="Random seed for reproducibility. Same seed + prompt = similar output.",
    )


class VeoChainRequest(CommonPayload):
    """Generate longer videos by chaining 8-second segments.

    Creates an initial 8s segment then extends it to reach 16s or 24s total duration.

    Example:
        {
            "prompt": "Product showcase video...",
            "storage_uri": "gs://my-bucket/videos/",
            "target_total_seconds": 16
        }
    """
    model: str = Field(
        default="veo-3.1-generate-preview",
        description="Veo model version.",
    )
    prompt: str = Field(
        description="Video generation prompt for the base segment.",
    )
    storage_uri: str = Field(
        description="GCS URI (gs://bucket/path) for storing video segments. Required.",
    )
    target_total_seconds: Literal[8, 16, 24] = Field(
        default=8,
        description="Target total video duration. 8s = single segment, 16s = 2 segments, 24s = 3 segments.",
    )
    sample_count: int = Field(default=1, ge=1, le=4, description="Samples per segment (1-4).")
    veo_mode: Literal["text", "image", "reference"] = Field(
        default="text",
        description="Generation mode for the base segment.",
    )
    extend_prompt: str = Field(
        default="",
        description="Custom prompt for extension segments. If empty, auto-generates continuation prompt.",
    )
    poll_interval_seconds: int = Field(
        default=6,
        ge=1,
        le=30,
        description="Seconds between status polls. Default 6s is recommended.",
    )
    max_wait_seconds: int = Field(
        default=720,
        ge=60,
        le=1800,
        description="Maximum wait time per segment in seconds. Default 720s (12 min).",
    )
    extend_retry_max: int = Field(
        default=1,
        ge=0,
        le=2,
        description="Max retries for extend failures (0-2).",
    )
    seed: Optional[int] = Field(
        default=None,
        description="Random seed for reproducibility across segments.",
    )


class VeoStatusRequest(CommonPayload):
    """Check the status of a Veo video generation operation.

    Example:
        {"operation_name": "projects/xxx/locations/us-central1/..."}
    """
    model: str = Field(
        default="veo-3.1-generate-preview",
        description="Veo model version.",
    )
    operation_name: str = Field(
        description="Operation name returned from veo/start or veo/chain. "
                    "Format: 'projects/{project}/locations/{location}/...'",
    )


class VeoExtendRequest(CommonPayload):
    """Extend an existing video by appending a new segment.

    Example:
        {
            "prompt": "Continue the product showcase...",
            "source_video_gcs_uri": "gs://bucket/video.mp4"
        }
    """
    model: str = Field(
        default="veo-3.1-generate-preview",
        description="Veo model version.",
    )
    prompt: str = Field(description="Prompt for the extension segment.")
    source_video_gcs_uri: str = Field(
        description="GCS URI of the source video to extend. Must be gs:// path ending in .mp4",
    )


# ---------------------------------------------------------------------------
# Video Editing
# ---------------------------------------------------------------------------

class VideoEditExportRequest(BaseModel):
    """Export an edited video with speed, color grading, text overlay, and BGM.

    All edit parameters are optional; only specified edits are applied.

    Example:
        {
            "video_url": "https://storage.googleapis.com/...",
            "edits": {
                "speed": 1.2,
                "sat": 10,
                "maskText": "Shop Now!"
            }
        }
    """
    video_url: str = Field(
        description="URL of the source video to edit. Can be HTTP(S) URL or data:video/* base64.",
    )
    proxy: str = Field(default="", description="HTTP proxy for downloading the video.")
    edits: Dict[str, Any] = Field(
        default_factory=dict,
        description=(
            "Edit parameters (all optional): "
            "speed (0.5-2.0, playback speed), "
            "sat (-30 to 30, saturation), "
            "vibrance (-30 to 30, brightness/vibrance), "
            "temp (-30 to 30, colour temperature), "
            "tint (-30 to 30, colour tint/hue), "
            "contrast (-30 to 30, direct contrast boost independent of temp), "
            "fadeIn (0-3.0 s, fade-in duration at start), "
            "fadeOut (0-3.0 s, fade-out duration at end), "
            "maskText (text overlay string), "
            "maskStyle (elegant|bold|soft|neon|luxury|minimal|stamp|cinematic), "
            "maskFont (sans|serif|kai|impact|rounded|mono), "
            "maskColor (hex colour, e.g. #ffffff), "
            "opacity (0-100, text opacity), "
            "x (0-100, text X position %), "
            "y (0-100, text Y position %), "
            "w (10-100, text box width %), "
            "h (6-60, text height %), "
            "rotation (-30 to 30, text rotation deg), "
            "bgmExtract (bool, enable BGM mixing), "
            "bgmVolume (0-100, BGM volume %), "
            "bgmMood (elegant|daily|piano|energetic|happy|calm|trendy|romantic), "
            "localBgmDataUrl (data URL of BGM audio file)."
        ),
    )


class TimelineSegmentRequest(BaseModel):
    id: str = Field(default="", description="Segment ID. Auto-generated if omitted.")
    title: str = Field(default="", description="Segment title for UI display.")
    left: float = Field(
        default=0.0,
        ge=0.0,
        le=100.0,
        description="Segment start position in percentage (0-100).",
    )
    width: float = Field(
        default=10.0,
        gt=0.0,
        le=100.0,
        description="Segment width in percentage (>0, <=100).",
    )
    start_seconds: Optional[float] = Field(
        default=None,
        ge=0.0,
        description="Optional segment absolute start time in seconds. If provided, overrides left.",
    )
    end_seconds: Optional[float] = Field(
        default=None,
        gt=0.0,
        description="Optional segment absolute end time in seconds. If provided, overrides width.",
    )
    source_index: int = Field(
        default=0,
        ge=0,
        description="0-based index into source_videos list. Defaults to 0 (the primary source_video_url). "
                    "Use this to reference different source clips in a multi-source timeline.",
    )

    @field_validator("end_seconds")
    @classmethod
    def validate_end_seconds(cls, v: Optional[float], info):
        if v is None:
            return v
        start = info.data.get("start_seconds")
        if start is not None and float(v) <= float(start):
            raise ValueError("end_seconds must be greater than start_seconds")
        return v


class TimelineTrackRequest(BaseModel):
    label: str = Field(description="Track label, e.g. Video/Voice/Subtitle/BGM.")
    track_type: Literal["video", "voice", "subtitle", "bgm", "other"] = Field(
        default="video",
        description="Track type. The MVP renderer consumes only video track segments.",
    )
    enabled: bool = Field(
        default=True,
        description="Whether this track is enabled for rendering.",
    )
    muted: bool = Field(
        default=False,
        description="Whether audio from this track should be muted. MVP applies to video track audio.",
    )
    order: int = Field(
        default=0,
        description="Optional track order priority. Lower value renders first.",
    )
    segments: List[TimelineSegmentRequest] = Field(
        default_factory=list,
        description="Ordered list of segments within this track.",
    )


class VideoTimelineRenderRequest(BaseModel):
    source_video_url: str = Field(
        default="",
        description="Primary source video URL. Supports HTTP(S) URL or data:video/* base64. "
                    "Corresponds to source_index=0 in segments. Required unless source_videos is provided.",
    )
    source_videos: Optional[List[str]] = Field(
        default=None,
        description="List of source video URLs for multi-clip rendering. "
                    "Each entry supports HTTP(S) or data:video/*. "
                    "Segments reference a clip via source_index (0-based). "
                    "When provided, source_video_url is treated as source_videos[0] if not already included.",
    )
    proxy: str = Field(default="", description="HTTP proxy for downloading source video.")
    duration_seconds: Optional[float] = Field(
        default=None,
        gt=0.0,
        le=600.0,
        description="Optional timeline duration in seconds for percent-to-time conversion. "
                    "Defaults to the duration of the first source video if omitted.",
    )
    include_audio: bool = Field(
        default=True,
        description="Whether to keep and concatenate source audio.",
    )
    segment_sort_strategy: Literal["track_then_start", "start_then_track"] = Field(
        default="track_then_start",
        description="How segments are ordered before rendering. "
                    "'track_then_start' keeps track priority first; "
                    "'start_then_track' uses global timeline order first.",
    )
    async_job: bool = Field(
        default=False,
        description="If true, create an async render job and return job_id immediately.",
    )
    tracks: List[TimelineTrackRequest] = Field(
        default_factory=list,
        description="Timeline tracks and segments. Uses video tracks for MVP rendering.",
    )

    @field_validator("source_video_url")
    @classmethod
    def validate_source_video_url(cls, v: str) -> str:
        v = str(v or "").strip()
        if v and not (v.startswith("http://") or v.startswith("https://") or v.startswith("data:video/")):
            raise ValueError("source_video_url must be http(s) or data:video/*")
        return v

    @field_validator("source_videos")
    @classmethod
    def validate_source_videos(cls, v: Optional[List[str]]) -> Optional[List[str]]:
        if v is None:
            return v
        result = []
        for url in v:
            url = str(url or "").strip()
            if not url:
                raise ValueError("source_videos entries must be non-empty URLs")
            if not (url.startswith("http://") or url.startswith("https://") or url.startswith("data:video/")):
                raise ValueError("source_videos entries must be http(s) or data:video/*")
            result.append(url)
        if not result:
            raise ValueError("source_videos must not be empty if provided")
        return result

    @field_validator("tracks")
    @classmethod
    def validate_tracks(cls, tracks: List[TimelineTrackRequest]) -> List[TimelineTrackRequest]:
        if not tracks:
            raise ValueError("tracks is required")
        total_segments = sum(len(t.segments) for t in tracks)
        if total_segments <= 0:
            raise ValueError("at least one segment is required")
        if total_segments > 80:
            raise ValueError("too many segments (max 80)")
        return tracks

    def resolved_source_videos(self) -> List[str]:
        """Return the ordered list of source URLs (source_videos takes precedence)."""
        if self.source_videos:
            return list(self.source_videos)
        if self.source_video_url:
            return [self.source_video_url]
        raise ValueError("source_video_url or source_videos is required")


# ---------------------------------------------------------------------------
# Jimeng (即梦) Video / Image Generation
# ---------------------------------------------------------------------------

class JimengVideoRequest(BaseModel):
    """Generate a video using Jimeng (即梦) API — ByteDance proxy at http://43.163.110.48.

    Supports text-to-video, image-to-video, and first-last-frame video.
    Credit cost: 3.5-pro = 3 credits/call, 3.0 = 2 credits/call.

    Example:
        {
            "prompt": "一只可爱的小猫在草地上玩耍",
            "model": "3.5-pro",
            "ratio": "16:9",
            "duration": 10
        }
    """
    prompt: str = Field(
        description="视频描述提示词。Example: '一只可爱的小猫在草地上玩耍'",
    )
    model: Literal["3.5-pro", "3.0"] = Field(
        default="3.5-pro",
        description="模型版本。3.5-pro (3积分/次，最佳质量), 3.0 (2积分/次，标准质量).",
    )
    ratio: str = Field(
        default="16:9",
        description="视频比例。支持 '1:1', '9:16', '16:9'.",
    )
    duration: Literal[5, 10] = Field(
        default=10,
        description="视频时长（秒），支持 5 或 10；默认 10。",
    )
    resolution: str = Field(
        default="720p",
        description="分辨率，目前仅支持 720p。",
    )
    image_url: Optional[str] = Field(
        default=None,
        description="参考图片 URL（图生视频首帧）。图片需小于 2MB。",
    )
    image_base64: Optional[str] = Field(
        default=None,
        description="参考图片 base64（图生视频首帧，带或不带 data: 前缀）。",
    )
    last_frame_url: Optional[str] = Field(
        default=None,
        description="末帧图片 URL（首尾帧视频）。需同时提供 image_url/image_base64。",
    )
    last_frame_base64: Optional[str] = Field(
        default=None,
        description="末帧图片 base64（首尾帧视频）。",
    )
    proxy: str = Field(
        default="",
        description="HTTP 代理 URL（下载外网视频文件时使用）。Example: 'http://127.0.0.1:7890'",
    )


class JimengImageRequest(BaseModel):
    """Generate images using Jimeng (即梦) image API.

    Credit cost: 1 credit/call (jimeng-4.x, 5.0), 2 credits (nanobanana, 4K +2).

    Example:
        {
            "prompt": "一只可爱的小猫在草地上玩耍",
            "model": "jimeng-5.0",
            "ratio": "16:9"
        }
    """
    prompt: str = Field(
        default="",
        description="图片描述提示词。",
    )
    model: str = Field(
        default="jimeng-5.0",
        description="模型名称。支持: jimeng-5.0, jimeng-4.6, jimeng-4.5, jimeng-4.1, jimeng-4.0, nanobanana.",
    )
    ratio: str = Field(
        default="1:1",
        description="图片比例。支持 '1:1', '9:16', '16:9'.",
    )
    resolution: str = Field(
        default="2k",
        description="分辨率。2k (默认) 或 4k (+2积分)。nanobanana 固定 1k。",
    )
    image_url: Optional[str] = Field(
        default=None,
        description="参考图片 URL（图生图）。",
    )
    image_base64: Optional[str] = Field(
        default=None,
        description="参考图片 base64（图生图）。",
    )
    proxy: str = Field(
        default="",
        description="HTTP 代理 URL。",
    )


# ---------------------------------------------------------------------------
# LTX-Video Generation
# ---------------------------------------------------------------------------

class LtxvGenerateRequest(BaseModel):
    """Generate a video using LTX-Video 2.3 via Lightricks API (api.ltx.video).

    Supports text-to-video and image-to-video (provide image_url/image_base64).
    The API is synchronous — returns the MP4 file directly.

    Duration limits:
      ltx-2-3-fast + 1080p  → up to 20s
      all other models/res  → up to 10s

    Example:
        {
            "prompt": "A woman walks gracefully in a sunlit forest, slow motion",
            "duration": 5,
            "resolution": "1920x1080"
        }
    """
    prompt: str = Field(
        description="Detailed video prompt: subject, action, lighting, style. "
                    "Example: 'Close-up of a luxury watch rotating on dark velvet, studio lighting, macro'.",
    )
    model: str = Field(
        default="ltx-2-3-pro",
        description="Model name. Options: ltx-2-3-pro (best quality, ≤10s), "
                    "ltx-2-3-fast (faster, up to 20s at 1080p), "
                    "ltx-2-pro, ltx-2-fast.",
    )
    duration: int = Field(
        default=5,
        ge=1,
        le=20,
        description="Duration in seconds. Max 20s for ltx-2-3-fast at 1080p; max 10s for all other models/resolutions.",
    )
    resolution: str = Field(
        default="1920x1080",
        description="Output resolution. Landscape: 1920x1080, 2560x1440, 3840x2160. "
                    "Portrait (ltx-2.3 only): 1080x1920, 1440x2560, 2160x3840.",
    )
    fps: int = Field(
        default=24,
        description="Frame rate. 24 (default), 25, or 50 (smooth slow-motion, ltx-2.3 only).",
    )
    generate_audio: bool = Field(
        default=True,
        description="Whether to auto-generate ambient audio. Default true.",
    )
    camera_motion: Optional[str] = Field(
        default=None,
        description="Camera movement preset. Options: dolly_in, dolly_out, dolly_left, dolly_right, "
                    "jib_up, jib_down, static, focus_shift. Leave empty for auto.",
    )
    image_url: Optional[str] = Field(
        default=None,
        description="First-frame image URL for image-to-video mode.",
    )
    image_base64: Optional[str] = Field(
        default=None,
        description="First-frame image as base64 (with or without data: prefix) for image-to-video.",
    )
    last_frame_url: Optional[str] = Field(
        default=None,
        description="Last-frame image URL for first-to-last-frame control. ltx-2.3 models only.",
    )
    last_frame_base64: Optional[str] = Field(
        default=None,
        description="Last-frame image as base64. ltx-2.3 models only.",
    )


class LtxvExtendRequest(BaseModel):
    """Extend an existing LTX-Video video (pro models only).

    Example:
        {
            "video_url": "http://127.0.0.1:8000/api/ltxv/download/ltxv_xxx.mp4",
            "duration": 5,
            "prompt": "Continue the scene with a slow pan right"
        }
    """
    video_url: str = Field(
        description="URL of the source video to extend. Must be publicly accessible or a local /api/ltxv/download/* URL.",
    )
    duration: int = Field(
        default=5,
        ge=2,
        le=20,
        description="Seconds to extend by (2–20).",
    )
    prompt: Optional[str] = Field(
        default=None,
        description="Optional description of the extended content.",
    )
    mode: Literal["end", "start"] = Field(
        default="end",
        description="Append to the end ('end') or prepend to the start ('start').",
    )
    model: str = Field(
        default="ltx-2-3-pro",
        description="Pro model for extend. Options: ltx-2-3-pro, ltx-2-pro.",
    )


# ---------------------------------------------------------------------------
# Image Generation
# ---------------------------------------------------------------------------

class ShopliveImageGenerateRequest(CommonPayload):
    """Generate product images optimized for e-commerce.

    Auto-detects whether to use model/no-model/contact-lens template based on product category.
    Includes automatic category validation with retry on mismatch.

    Example:
        {
            "product_name": "Floral Summer Dress",
            "main_category": "dress",
            "selling_region": "US",
            "selling_points": "lightweight, floral print"
        }
    """
    product_name: str = Field(
        description="Product name. Used to determine template and validate generated image.",
    )
    main_category: str = Field(
        default="",
        description="Product category. Examples: 'dress', 'shoes', 'watch', 'phone', 'contact lens'. "
                    "Affects template selection and category validation.",
    )
    target_audience: str = Field(
        default="general online shoppers",
        description="Target customer description. Example: 'Young women 18-30'",
    )
    brand_philosophy: str = Field(
        default="clean and premium",
        description="Brand style direction. Examples: 'clean and premium', 'sporty casual'",
    )
    selling_region: str = Field(
        default="global market",
        description="Target sales region. Used to infer model ethnicity. "
                    "Examples: 'US', 'Japan', 'Saudi Arabia', 'Europe'",
    )
    selling_points: str = Field(
        default="",
        description="Key product selling points, comma-separated.",
    )
    sample_count: int = Field(
        default=2,
        ge=1,
        le=4,
        description="Number of images to generate (1-4).",
    )
    aspect_ratio: str = Field(
        default="3:4",
        description="Image aspect ratio. Default 3:4 for product photography.",
    )
    category_retry_max: int = Field(
        default=2,
        ge=0,
        le=4,
        description="Max retries when generated image doesn't match expected category (0-4).",
    )


# ---------------------------------------------------------------------------
# Schema Registry (for tool manifest)
# ---------------------------------------------------------------------------

TOOL_SCHEMAS: Dict[str, type] = {
    "parse_product_url": ProductInsightRequest,
    "analyze_product_image": ImageInsightRequest,
    "chat_with_llm": AgentChatRequest,
    "agent_run": AgentRunRequest,
    "run_video_workflow": VideoWorkflowRequest,
    "analyze_hot_video_remake": HotVideoRemakeRequest,
    "generate_video": VeoStartRequest,
    "chain_video_segments": VeoChainRequest,
    "check_video_status": VeoStatusRequest,
    "extend_video": VeoExtendRequest,
    "export_edited_video": VideoEditExportRequest,
    "render_video_timeline": VideoTimelineRenderRequest,
    "generate_product_image": ShopliveImageGenerateRequest,
    "generate_video_ltxv": LtxvGenerateRequest,
    "extend_video_ltxv": LtxvExtendRequest,
    "generate_video_jimeng": JimengVideoRequest,
    "generate_image_jimeng": JimengImageRequest,
}
