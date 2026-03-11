"""
LLM-Friendly Tool Registry for Shoplive Agent.

Design principles (from "一文读懂 Agent Tools"):
- Tool names use "verb-noun" structure (e.g., parse_product_url, not call_http_endpoint)
- Descriptions use natural language, avoiding obscure technical terms
- 50% of effort goes into polishing docstrings with Examples and Sample Cases
- Single Responsibility: each tool does one thing well
- Output schemas return summaries first, full data on demand
- Recovery suggestions guide the Agent to retry on failure

This registry can be:
1. Served as a /api/tools/manifest endpoint for Agent discovery
2. Auto-converted to MCP Tool Definitions
3. Used for intelligent tool recall (tag-based filtering)
"""

from typing import Any, Dict, List


# ---------------------------------------------------------------------------
# Tool Definition Schema
# ---------------------------------------------------------------------------

TOOL_REGISTRY: List[Dict[str, Any]] = [
    # === Skill: Product Analysis ===
    {
        "name": "parse_product_url",
        "display_name": "Parse Product URL",
        "description": (
            "Scrape and parse a product URL from an e-commerce platform. "
            "Extracts product name, images, selling points, reviews, and price information. "
            "Supports 10+ platforms including Amazon, Shein, Taobao, JD, Temu. "
            "Use this when the user provides a product link and you need structured product data."
        ),
        "endpoint": "POST /api/agent/shop-product-insight",
        "tags": ["product", "scraping", "analysis"],
        "skill": "product_analysis",
        "parameters": {
            "product_url": {
                "type": "string",
                "required": True,
                "description": "Full product page URL (http/https). Example: 'https://www.amazon.com/dp/B0XXXXXX'",
            },
            "language": {
                "type": "string",
                "enum": ["zh", "en"],
                "default": "zh",
                "description": "Output language. 'zh' for Chinese, 'en' for English.",
            },
            "proxy": {
                "type": "string",
                "default": "",
                "description": "HTTP proxy. Leave empty for auto-detection.",
            },
        },
        "output_summary": {
            "insight": "Structured product data (product_name, selling_points, image_items)",
            "confidence": "Data quality: 'high', 'medium', or 'low'",
            "fallback_reason": "Reason if fallback scraper was used",
        },
        "examples": [
            {
                "input": {"product_url": "https://www.amazon.com/dp/B0D1234", "language": "en"},
                "expected_output_keys": ["insight", "confidence", "source"],
            }
        ],
        "common_errors": {
            "anti_bot": "Page blocked by anti-bot → try with proxy or switch to analyze_product_image",
            "empty_result": "Could not extract data → verify URL is a product page, not a listing/search page",
        },
        "next_tools": [
            "After getting product data → use run_video_workflow to generate a video script",
            "If images were extracted → use analyze_product_image for deeper visual analysis",
        ],
    },
    {
        "name": "analyze_product_image",
        "display_name": "Analyze Product Image",
        "description": (
            "Analyze 1-6 product images using Google Gemini to extract structured metadata: "
            "product name, category, selling points, style template, target user, and sales region. "
            "Use this when you have product images but no URL, or want deeper visual analysis."
        ),
        "endpoint": "POST /api/agent/image-insight",
        "tags": ["product", "image", "analysis", "gemini"],
        "skill": "product_analysis",
        "parameters": {
            "image_url": {
                "type": "string",
                "description": "Product image URL. Simplest way to provide an image.",
            },
            "image_base64": {
                "type": "string",
                "description": "Base64-encoded image. Use when image is already in memory.",
            },
            "image_items": {
                "type": "array",
                "description": "List of {base64, mime_type} objects. For multi-image analysis.",
            },
            "language": {
                "type": "string",
                "enum": ["zh", "en"],
                "default": "zh",
                "description": "Output language for product descriptions.",
            },
        },
        "output_summary": {
            "insight": "Structured product metadata (product_name, selling_points, style_template, etc.)",
        },
        "next_tools": [
            "After getting product metadata → use run_video_workflow to generate a video script",
            "Use generate_product_image to create studio-quality product photos",
        ],
    },
    {
        "name": "chat_with_llm",
        "display_name": "Chat with LLM",
        "description": (
            "General-purpose LLM conversation interface via LiteLLM. "
            "Use this for free-form text generation, summarization, translation, or any task "
            "that doesn't fit a specific tool. Supports multi-turn conversations."
        ),
        "endpoint": "POST /api/agent/chat",
        "tags": ["chat", "llm", "general"],
        "skill": "general",
        "parameters": {
            "prompt": {
                "type": "string",
                "description": "Single user message. Simplest usage pattern.",
            },
            "messages": {
                "type": "array",
                "description": "Full conversation [{role: 'user'|'assistant'|'system', content: '...'}].",
            },
        },
        "output_summary": {
            "content": "LLM response text",
        },
    },

    # === Skill: Video Generation ===
    {
        "name": "run_video_workflow",
        "display_name": "Run Video Workflow",
        "description": (
            "Execute a step in the video creation pipeline. "
            "Steps: validate → generate_script → pre_export_check → build_export_prompt. "
            "This is the main orchestration tool for converting product info into a Veo-ready prompt. "
            "Start with 'validate' to check inputs, then 'generate_script' for the storyboard, "
            "then 'build_export_prompt' for the final Veo prompt."
        ),
        "endpoint": "POST /api/shoplive/video/workflow",
        "tags": ["video", "workflow", "script", "prompt"],
        "skill": "video_generation",
        "parameters": {
            "action": {
                "type": "string",
                "enum": ["validate", "generate_script", "pre_export_check", "build_export_prompt", "build_enhance_template"],
                "default": "generate_script",
                "description": "Which workflow step to execute.",
            },
            "input": {
                "type": "object",
                "description": "Brief with: product_name, selling_points, target_user, sales_region, duration, aspect_ratio.",
            },
        },
        "output_summary": {
            "ready": "Whether the current step passed (bool)",
            "validation": "Brief validation result with issues list",
            "script": "Generated video script (for generate_script action)",
            "prompt": "Final Veo prompt (for build_export_prompt action)",
        },
        "next_tools": [
            "After build_export_prompt → use generate_video or chain_video_segments to create the video",
        ],
    },
    {
        "name": "generate_video",
        "display_name": "Generate Video",
        "description": (
            "Submit a single video generation task to Google Veo. "
            "Supports text-to-video, image-to-video, and reference-based generation. "
            "Returns an operation_name for status polling. "
            "For videos longer than 8s, use chain_video_segments instead."
        ),
        "endpoint": "POST /api/veo/start",
        "tags": ["video", "veo", "generation"],
        "skill": "video_generation",
        "parameters": {
            "prompt": {
                "type": "string",
                "required": True,
                "description": "Detailed video generation prompt with scene, lighting, camera work, and actions.",
            },
            "veo_mode": {
                "type": "string",
                "enum": ["text", "image", "reference"],
                "default": "text",
                "description": "'text': prompt only. 'image': prompt + first frame image. 'reference': with style reference images.",
            },
            "duration_seconds": {
                "type": "integer",
                "enum": [4, 6, 8],
                "description": "Video duration. Only 4, 6, or 8 seconds supported per segment.",
            },
            "aspect_ratio": {
                "type": "string",
                "description": "Video aspect ratio: '16:9', '9:16', or '1:1'.",
            },
        },
        "output_summary": {
            "operation_name": "Use this to poll status with check_video_status",
        },
        "next_tools": [
            "After submitting → use check_video_status to poll until done",
            "After video is ready → use export_edited_video for post-production",
        ],
    },
    {
        "name": "chain_video_segments",
        "display_name": "Chain Video Segments",
        "description": (
            "Generate longer videos (16s or 24s) by chaining 8-second segments. "
            "Automatically handles base generation + extension with consistency. "
            "This is a synchronous, blocking call that returns the final video URL."
        ),
        "endpoint": "POST /api/veo/chain",
        "tags": ["video", "veo", "chain", "long-form"],
        "skill": "video_generation",
        "parameters": {
            "prompt": {"type": "string", "required": True, "description": "Video prompt."},
            "storage_uri": {"type": "string", "required": True, "description": "GCS URI for output (gs://...)."},
            "target_total_seconds": {
                "type": "integer",
                "enum": [8, 16, 24],
                "default": 8,
                "description": "Total video duration: 8 (1 segment), 16 (2 segments), or 24 (3 segments).",
            },
        },
        "output_summary": {
            "final_video_gcs_uri": "GCS path to the final concatenated video",
            "final_signed_video_url": "Signed HTTPS URL for direct playback (valid 1 hour)",
            "segments": "Details of each generated segment",
        },
    },
    {
        "name": "check_video_status",
        "display_name": "Check Video Status",
        "description": (
            "Poll the status of a Veo video generation operation. "
            "Returns signed video URLs when generation is complete. "
            "Typically poll every 6 seconds until done=true."
        ),
        "endpoint": "POST /api/veo/status",
        "tags": ["video", "veo", "status"],
        "skill": "video_generation",
        "parameters": {
            "operation_name": {
                "type": "string",
                "required": True,
                "description": "Operation name from generate_video response.",
            },
        },
        "output_summary": {
            "video_uris": "List of generated video GCS URIs (empty if still processing)",
            "signed_video_urls": "Signed HTTPS URLs for direct playback",
        },
    },
    {
        "name": "extend_video",
        "display_name": "Extend Video",
        "description": (
            "Extend an existing video by appending a new segment. "
            "The extension maintains visual consistency with the source video. "
            "For automated chaining, prefer chain_video_segments."
        ),
        "endpoint": "POST /api/veo/extend",
        "tags": ["video", "veo", "extend"],
        "skill": "video_generation",
        "parameters": {
            "prompt": {"type": "string", "required": True, "description": "Extension prompt."},
            "source_video_gcs_uri": {
                "type": "string",
                "required": True,
                "description": "GCS URI of the video to extend (gs://.../*.mp4).",
            },
        },
    },

    # === Skill: Video Editing ===
    {
        "name": "export_edited_video",
        "display_name": "Export Edited Video",
        "description": (
            "Apply post-production edits and export the final video. "
            "Supports speed adjustment (0.5x–2x), color grading, text overlay, and BGM mixing. "
            "Always pass an 'edits' object with the specific edit fields — "
            "e.g. {'speed': 2.0} to double speed, {'sat': 1.3} to boost saturation. "
            "Returns a download URL for the edited video."
        ),
        "endpoint": "POST /api/video/edit/export",
        "tags": ["video", "editing", "export", "ffmpeg"],
        "skill": "video_editing",
        "parameters": {
            "video_url": {
                "type": "string",
                "required": True,
                "description": "Source video URL (HTTPS or signed GCS URL).",
            },
            "edits": {
                "type": "object",
                "required": True,
                "description": (
                    "Edit parameters object. All fields are optional — include only those you want to change. "
                    "Fields (use EXACT field names): "
                    "speed (float 0.5–2.0, e.g. 2.0 = double speed, 0.5 = half speed), "
                    "sat (float 0.0–3.0, saturation multiplier, 1.0 = original), "
                    "vibrance (float -1.0–1.0), "
                    "temp (float -1.0–1.0, color temperature warm/cool), "
                    "tint (float -1.0–1.0), "
                    "maskText (string, text to burn into the video frame — use this field name exactly, NOT 'text_overlay'), "
                    "bgmExtract (bool, extract background music), "
                    "bgmVolume (float 0.0–1.0). "
                    "Examples: {'speed': 1.5, 'sat': 1.2} or {'maskText': '限时特卖'} or {'speed': 2.0}."
                ),
            },
        },
        "output_summary": {
            "video_url": "Download URL for the edited video",
            "mask_applied": "Whether text overlay was successfully applied",
        },
    },
    {
        "name": "render_video_timeline",
        "display_name": "Render Video Timeline",
        "description": (
            "Cut and concatenate segments from a source video based on a timeline. "
            "Use this to clip a specific time range or assemble multiple segments. "
            "Pass 'tracks' with a list of segments, each specifying start/end in seconds. "
            "Example: to keep seconds 1-3, use tracks=[{label:'Video', segments:[{start_seconds:1, end_seconds:3}]}]."
        ),
        "endpoint": "POST /api/video/timeline/render",
        "tags": ["video", "timeline", "editing", "render", "ffmpeg"],
        "skill": "video_editing",
        "parameters": {
            "source_video_url": {
                "type": "string",
                "required": True,
                "description": "Source video URL (HTTPS).",
            },
            "duration_seconds": {
                "type": "number",
                "description": "Total video duration in seconds. Used when segments use percentages. Optional if using start_seconds/end_seconds.",
            },
            "include_audio": {
                "type": "boolean",
                "default": True,
                "description": "Whether to keep audio in output. Default true.",
            },
            "tracks": {
                "type": "array",
                "required": True,
                "description": (
                    "Array of timeline tracks. Each track has: "
                    "label (string, e.g. 'Video'), "
                    "segments (array of segment objects). "
                    "Each segment: {start_seconds: number, end_seconds: number}. "
                    "Example: [{label: 'Video', segments: [{start_seconds: 1.0, end_seconds: 3.0}]}]"
                ),
                "items": {
                    "type": "object",
                    "properties": {
                        "label": {"type": "string"},
                        "segments": {
                            "type": "array",
                            "items": {
                                "type": "object",
                                "properties": {
                                    "start_seconds": {"type": "number"},
                                    "end_seconds": {"type": "number"},
                                },
                            },
                        },
                    },
                },
            },
        },
        "output_summary": {
            "video_url": "Rendered timeline output URL",
            "segments_rendered": "Number of segments rendered into final video",
            "timeline_duration_seconds": "Duration used for timeline normalization",
        },
        "next_tools": [
            "After rendering → use export_edited_video for color/BGM/mask post-processing",
        ],
    },

    # === Skill: Image Generation ===
    {
        "name": "generate_product_image",
        "display_name": "Generate Product Image",
        "description": (
            "Generate studio-quality product images for e-commerce. "
            "Auto-selects template: model+apparel, product-only, or contact lens macro. "
            "Includes automatic category validation with retry on mismatch."
        ),
        "endpoint": "POST /api/shoplive/image/generate",
        "tags": ["image", "generation", "product"],
        "skill": "image_generation",
        "parameters": {
            "product_name": {"type": "string", "required": True, "description": "Product name."},
            "main_category": {"type": "string", "description": "Category: 'dress', 'shoes', 'watch', etc."},
            "selling_region": {"type": "string", "description": "Target market for model ethnicity inference."},
            "selling_points": {"type": "string", "description": "Key product selling points."},
        },
        "output_summary": {
            "images": "Generated images with base64 data and data_url",
            "prompt_strategy": "Which template was used",
            "category_check": "Whether generated image matched expected category",
        },
    },
]


# ---------------------------------------------------------------------------
# Skills Grouping (Article: "将工具升级为技能 Skills")
# ---------------------------------------------------------------------------

SKILL_DEFINITIONS: Dict[str, Dict[str, Any]] = {
    "product_analysis": {
        "name": "product_analysis",
        "display_name": "Product Analysis",
        "description": (
            "Analyze products from URLs or images to extract structured metadata. "
            "Typical flow: parse_product_url → get product data, or "
            "analyze_product_image → get visual metadata."
        ),
        "tools": ["parse_product_url", "analyze_product_image"],
        "typical_flow": [
            "1. parse_product_url → extract product name, images, selling points",
            "2. analyze_product_image → enrich with visual analysis if needed",
            "3. Pass results to video_generation skill",
        ],
    },
    "video_generation": {
        "name": "video_generation",
        "display_name": "Video Generation",
        "description": (
            "Complete pipeline from product brief to generated video. "
            "Typical flow: run_video_workflow(validate) → run_video_workflow(generate_script) → "
            "run_video_workflow(build_export_prompt) → generate_video or chain_video_segments → "
            "check_video_status."
        ),
        "tools": ["run_video_workflow", "generate_video", "chain_video_segments", "check_video_status", "extend_video"],
        "typical_flow": [
            "1. run_video_workflow(action='validate') → check brief completeness",
            "2. run_video_workflow(action='generate_script') → create storyboard script",
            "3. run_video_workflow(action='build_export_prompt') → build final Veo prompt",
            "4a. generate_video → for single segment (4/6/8s), then check_video_status to poll",
            "4b. chain_video_segments → for longer videos (16/24s), returns final URL directly",
        ],
    },
    "video_editing": {
        "name": "video_editing",
        "display_name": "Video Post-Production",
        "description": (
            "Apply post-production edits to generated videos: speed, color grading, "
            "text overlay, and BGM mixing."
        ),
        "tools": ["render_video_timeline", "export_edited_video"],
        "typical_flow": [
            "1. render_video_timeline to produce timeline-based draft (optional)",
            "2. export_edited_video with desired post-processing edits",
        ],
    },
    "image_generation": {
        "name": "image_generation",
        "display_name": "Product Image Generation",
        "description": (
            "Generate studio-quality product images for e-commerce. "
            "Auto-selects the best template based on product category."
        ),
        "tools": ["generate_product_image"],
        "typical_flow": [
            "1. generate_product_image with product details",
            "2. If image-to-video needed → pass to generate_video with veo_mode='image'",
        ],
    },
}


def get_tools_by_skill(skill_name: str) -> List[Dict[str, Any]]:
    """Return tools filtered by skill name."""
    return [t for t in TOOL_REGISTRY if t.get("skill") == skill_name]


def get_tools_by_tags(tags: List[str]) -> List[Dict[str, Any]]:
    """Return tools matching any of the given tags."""
    tag_set = set(tags)
    return [t for t in TOOL_REGISTRY if tag_set & set(t.get("tags", []))]


def get_tool_by_name(name: str) -> Dict[str, Any]:
    """Return a single tool definition by name."""
    for t in TOOL_REGISTRY:
        if t["name"] == name:
            return t
    return {}


def build_tool_manifest() -> Dict[str, Any]:
    """Build the complete tool manifest for Agent consumption."""
    return {
        "version": "1.0",
        "total_tools": len(TOOL_REGISTRY),
        "skills": SKILL_DEFINITIONS,
        "tools": TOOL_REGISTRY,
    }


def build_openai_tools(tool_names: List[str] = None) -> List[Dict[str, Any]]:
    """Convert TOOL_REGISTRY entries to OpenAI function-calling format.

    Args:
        tool_names: Optional whitelist of tool names to include.
                    None or empty list means include all tools.

    Returns:
        List of dicts in OpenAI ``tools`` format:
        [{"type": "function", "function": {"name": ..., "description": ..., "parameters": {...}}}]
    """
    whitelist = set(tool_names) if tool_names else None
    result = []
    for tool_def in TOOL_REGISTRY:
        if whitelist and tool_def["name"] not in whitelist:
            continue
        properties: Dict[str, Any] = {}
        required: List[str] = []
        for param_name, param_info in (tool_def.get("parameters") or {}).items():
            prop: Dict[str, Any] = {
                "type": param_info.get("type", "string"),
                "description": param_info.get("description", ""),
            }
            if "enum" in param_info:
                prop["enum"] = param_info["enum"]
            if "default" in param_info:
                prop["default"] = param_info["default"]
            if "items" in param_info:
                prop["items"] = param_info["items"]
            properties[param_name] = prop
            if param_info.get("required"):
                required.append(param_name)
        result.append({
            "type": "function",
            "function": {
                "name": tool_def["name"],
                "description": tool_def["description"],
                "parameters": {
                    "type": "object",
                    "properties": properties,
                    "required": required,
                },
            },
        })
    return result
