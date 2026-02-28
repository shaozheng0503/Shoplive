"""
Skills Layer for Shoplive Agent.

Design principles (from "一文读懂 Agent Tools"):
- Skills = upgraded tools with lifecycle management, reusability, and orchestration
- Task-oriented, not API-oriented: each Skill describes "what to accomplish"
- Progressive disclosure: load only relevant tools per task context
- Agent Skill = "操作说明书", guides the Agent step-by-step through complex flows

This module defines executable Skill configurations that an Agent can load
and follow to complete complex multi-step tasks.
"""

from typing import Any, Dict, List


# ---------------------------------------------------------------------------
# Skill Definitions (Article: "Skills 消除工具碎片化和技能孤岛")
# ---------------------------------------------------------------------------

SKILL_CATALOG: List[Dict[str, Any]] = [
    {
        "id": "product_to_video",
        "name": "Product URL to Video",
        "version": "1.0",
        "description": (
            "End-to-end skill: from a product URL to a generated e-commerce video. "
            "Handles product scraping, script generation, prompt building, and Veo video creation."
        ),
        "tags": ["e2e", "video", "product"],
        "required_tools": [
            "parse_product_url",
            "run_video_workflow",
            "generate_video",
            "check_video_status",
        ],
        "optional_tools": [
            "analyze_product_image",
            "chain_video_segments",
            "export_edited_video",
        ],
        "execution_guide": """
## Product URL → Video Generation Skill

### Prerequisites
- Product URL from an e-commerce platform
- Google Cloud credentials (auto-detected)
- LiteLLM API key (from env or payload)

### Steps

**Step 1: Parse Product URL**
```
POST /api/agent/shop-product-insight
{
    "product_url": "<user's product URL>",
    "language": "zh"
}
```
→ Extract: product_name, selling_points, image_items

**Step 2: Validate Brief**
```
POST /api/shoplive/video/workflow
{
    "action": "validate",
    "input": {
        "product_name": "<from step 1>",
        "selling_points": "<from step 1>",
        "target_user": "<ask user or infer>",
        "sales_region": "<ask user or infer>",
        "duration": 8,
        "image_count": <number of images from step 1>
    }
}
```
→ If validation fails, ask user for missing fields (check issues list)

**Step 3: Generate Script**
```
POST /api/shoplive/video/workflow
{
    "action": "generate_script",
    "input": { ... same as step 2 ... }
}
```
→ Returns a structured video script with shots, BGM, and copy

**Step 4: Build Export Prompt**
```
POST /api/shoplive/video/workflow
{
    "action": "build_export_prompt",
    "input": { ... same as step 2 ... },
    "script_text": "<script from step 3>"
}
```
→ Returns a Veo-compatible video generation prompt

**Step 5: Generate Video**
For single segment (4/6/8s):
```
POST /api/veo/start
{
    "prompt": "<prompt from step 4>",
    "duration_seconds": 8,
    "aspect_ratio": "16:9"
}
```
→ Returns operation_name

For longer video (16/24s):
```
POST /api/veo/chain
{
    "prompt": "<prompt from step 4>",
    "storage_uri": "gs://your-bucket/videos/",
    "target_total_seconds": 16
}
```
→ Returns final_signed_video_url directly

**Step 6: Poll Status (if using veo/start)**
```
POST /api/veo/status
{
    "operation_name": "<from step 5>"
}
```
→ Poll every 6 seconds until signed_video_urls is non-empty

**Step 7 (Optional): Post-Production**
```
POST /api/video/edit/export
{
    "video_url": "<signed URL from step 5/6>",
    "edits": {"speed": 1.0, "sat": 5, "maskText": "Shop Now!"}
}
```
→ Returns edited video download URL

### Error Handling
- Step 1 fails with anti-bot → retry with proxy, or use image-insight instead
- Step 3 LLM fails → template fallback is automatic, check script_source field
- Step 5 Veo fails → check error message, simplify prompt, retry
- Step 6 timeout → increase max_wait_seconds or reduce video complexity
""",
    },
    {
        "id": "image_to_video",
        "name": "Product Image to Video",
        "version": "1.0",
        "description": (
            "Generate a video from product images. "
            "Analyzes images for metadata, then creates an image-to-video generation."
        ),
        "tags": ["image", "video", "i2v"],
        "required_tools": [
            "analyze_product_image",
            "run_video_workflow",
            "generate_video",
            "check_video_status",
        ],
        "execution_guide": """
## Product Image → Video Generation Skill

### Steps

**Step 1: Analyze Product Image**
```
POST /api/agent/image-insight
{
    "image_url": "<product image URL>",
    "language": "zh"
}
```
→ Extract product metadata

**Step 2-4: Same as product_to_video skill (validate → script → prompt)**

**Step 5: Generate Video with Image**
```
POST /api/veo/start
{
    "prompt": "<from step 4>",
    "veo_mode": "image",
    "image_url": "<product image URL>",
    "duration_seconds": 8
}
```
→ Image serves as the first frame for visual consistency

**Step 6: Poll Status** (same as product_to_video)
""",
    },
    {
        "id": "batch_product_images",
        "name": "Batch Product Image Generation",
        "version": "1.0",
        "description": (
            "Generate multiple studio-quality product images with automatic category validation."
        ),
        "tags": ["image", "batch", "product"],
        "required_tools": ["generate_product_image"],
        "execution_guide": """
## Batch Product Image Generation Skill

### Steps

**Step 1: Generate Images**
```
POST /api/shoplive/image/generate
{
    "product_name": "Summer Floral Dress",
    "main_category": "dress",
    "selling_region": "US",
    "selling_points": "lightweight, floral print",
    "sample_count": 2
}
```
→ Auto-detects template (model/product-only/contact-lens)
→ Auto-validates category match with retry

### Notes
- Category validation uses Gemini to verify the generated image matches the product
- Up to 4 retries on category mismatch (configurable via category_retry_max)
- For apparel, model template is auto-selected with region-appropriate ethnicity
""",
    },
    {
        "id": "video_post_production",
        "name": "Video Post-Production",
        "version": "1.0",
        "description": (
            "Apply post-production edits to a generated video: speed, color, text, BGM."
        ),
        "tags": ["video", "editing", "post-production"],
        "required_tools": ["export_edited_video"],
        "execution_guide": """
## Video Post-Production Skill

### Edit Parameters Reference

| Parameter   | Range    | Default | Description                |
|-------------|----------|---------|----------------------------|
| speed       | 0.5-2.0  | 1.0     | Playback speed             |
| sat         | -30~30   | 0       | Saturation adjustment      |
| vibrance    | -30~30   | 0       | Color vibrance             |
| temp        | -30~30   | 0       | Color temperature           |
| tint        | -30~30   | 0       | Color tint                 |
| maskText    | string   | ""      | Text overlay content       |
| opacity     | 0-100    | 90      | Text opacity %             |
| x           | 0-100    | 50      | Text X position %          |
| y           | 0-100    | 88      | Text Y position %          |
| bgmExtract  | bool     | false   | Enable BGM mixing          |
| bgmVolume   | 0-100    | 70      | BGM volume %               |

### Example
```
POST /api/video/edit/export
{
    "video_url": "https://storage.googleapis.com/...",
    "edits": {
        "speed": 1.1,
        "sat": 8,
        "vibrance": 5,
        "maskText": "Limited Time Offer!"
    }
}
```
""",
    },
]


# ---------------------------------------------------------------------------
# Skill Discovery & Loading
# ---------------------------------------------------------------------------

def get_skill_by_id(skill_id: str) -> Dict[str, Any]:
    """Load a specific skill by ID."""
    for skill in SKILL_CATALOG:
        if skill["id"] == skill_id:
            return skill
    return {}


def get_skills_by_tags(tags: List[str]) -> List[Dict[str, Any]]:
    """Find skills matching any of the given tags."""
    tag_set = set(tags)
    return [s for s in SKILL_CATALOG if tag_set & set(s.get("tags", []))]


def list_skills_summary() -> List[Dict[str, str]]:
    """Return a concise list of available skills for Agent discovery.

    Following the article's "渐进式披露" principle: return summaries first,
    load full execution guides only when needed.
    """
    return [
        {
            "id": s["id"],
            "name": s["name"],
            "description": s["description"],
            "tags": s.get("tags", []),
            "required_tools": s.get("required_tools", []),
        }
        for s in SKILL_CATALOG
    ]
