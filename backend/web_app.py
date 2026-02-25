#!/usr/bin/env python3
import hashlib
import os
import subprocess
import tempfile
import uuid

from flask import Flask, request, send_from_directory

from shoplive.backend.briefing import (
    ALLOWED_VIDEO_DURATIONS,
    DEFAULT_VIDEO_DURATION,
    build_input_diff,
    build_shoplive_script,
    build_shoplive_script_prompt,
    build_shoplive_agent_enhance_template,
    build_shoplive_video_prompt_template,
    normalize_duration_seconds,
    normalize_shoplive_brief,
    normalize_selling_points,
    selfcheck_script,
    validate_shoplive_brief,
)
from shoplive.backend.infra import (
    PROJECT_ROOT as SHOPLIVE_PROJECT_ROOT,
    build_proxies,
    get_access_token,
    parse_common_payload,
)
from shoplive.backend.common.helpers import (
    json_error,
    fetch_image_as_base64,
    normalize_reference_urls,
    parse_data_url,
    parse_generic_data_url,
    escape_drawtext_text,
    download_video_to_file,
    normalize_reference_images_base64,
    extract_banana_urls,
    extract_imagen_images,
    extract_chat_content,
    extract_vertex_text,
    try_parse_json_object,
    parse_category_judge_text,
    judge_generated_image_category,
    call_litellm_chat,
    extract_gs_paths,
    extract_inline_videos,
    sign_gcs_url,
    run_google_image_generate,
    infer_target_race,
    build_shoplive_image_rule_capsule,
    build_shoplive_image_prompt,
    build_shoplive_image_prompt_compact,
    build_shoplive_image_prompt_safe_product_only,
)
from shoplive.backend.api.shoplive_api import register_shoplive_routes
from shoplive.backend.api.agent_api import register_agent_routes
from shoplive.backend.api.veo_api import register_veo_routes
from shoplive.backend.api.media_api import register_media_routes
from shoplive.backend.api.video_edit_api import register_video_edit_routes

FRONTEND_ROOT = (SHOPLIVE_PROJECT_ROOT / "shoplive" / "frontend").resolve()
FRONTEND_PAGES_DIR = (FRONTEND_ROOT / "pages").resolve()
app = Flask(__name__, static_folder=str(FRONTEND_ROOT), static_url_path="")
VIDEO_EDIT_EXPORT_DIR = (SHOPLIVE_PROJECT_ROOT / "shoplive_video_edits").resolve()
VIDEO_EDIT_EXPORT_DIR.mkdir(parents=True, exist_ok=True)


SHOPLIVE_VIDEO_SYSTEM_PROMPT = """
你是一位电商视频提示词总导演。你的任务是根据用户输入（商品信息、卖点、场景、目标人群、时长、画幅、可能的商品图）输出一条可直接用于视频生成的最终提示词。

你必须遵守以下硬性要求：
1) 只聚焦1-2个核心卖点，且在4/6/8秒内可执行。
2) 强制采用“1个主框架 + 1个辅助框架”，从4.1~4.6中选择，不可全部堆叠。
3) 优先商品一致性与真实感：有商品图时严格一致；无商品图时按品类合理想象，不畸形。
4) 禁止夸大、绝对化、虚构认证数据；禁止他牌标识、水印、乱码、畸形手和结构错误。
5) 最终输出只能是一条提示词正文，不要解释、不要列表、不要Markdown标题。
6) 必须包含合规后缀：
高光边缘干净，反光可控，材质纹理清晰，结构边缘锐利，不出现畸形手或错误结构，不出现他牌标识或水印。

你必须按以下模板字段组织最终提示词语义（可自然串联，不必逐行标签化）：
- Style
- Environment
- Tone & Pacing
- Camera / Cinematography
- Lighting (或 Lighting & Color)
- Actions / Scenes（分段动作链）
- Background Sound
- Transition / Editing
- Call to Action

4. 视频prompt框架（严格执行）

4.1 产品口播
- [Style]: 轻微手持抖动模拟第一人称，干净简约，信任感。
- [Environment]: 包含关键背景元素与光线特征，氛围符合生活方式。
- [Tone & Pacing]: 语气自然，节奏可快可慢但须匹配使用场景情绪。
- [Camera]: 随动作自然移动，景深可控，主体突出且保留环境信息。
- [Lighting]: 光线作用于产品表面，强化高光、质感和阴影层次。
- [Actions/Scenes]: 主体动作 -> 产品特写 -> 使用演示 -> 情绪体验 -> 收尾整理。
- [Background Sound]: 背景音乐 + 环境音。
- [Transition/Editing]: 匹配剪辑、平滑切换或跳切，节奏连贯。
- [Call to Action]: 人物动作+收尾强调。

4.2 UGC评测
- 真实UGC手持或POV，快节奏，生活感与代入感强。
- 结构：主体出场 -> 产品展示/特写 -> 使用演示 -> 前后对比(可选) -> 总结推荐。
- 光线以自然光/柔和室内光为主，保持干净明亮与真实肤色/材质。

4.3 痛点与解决
- Shot1 正确示范/解决方案全景
- Shot2 痛点/错误示范
- Shot3 解决方案细节特写
- Shot4 产品性能/功能特写
- Shot5 推荐/收尾镜头
- 以清晰对比推动转化，动作与台词围绕“问题->解决->证据->推荐”。

4.4 产品演示
- 极简电影感写实，强调流程可视化与日常仪式感。
- 结构：产品引入 -> 使用动作展示 -> 特写卖点 -> 体验/情绪展示 -> 收尾CTA。
- 镜头以中景+俯拍/特写平滑切换，光线自然柔和，材质细节清晰。

4.5 前后对比
- 现代都市达人带货风格，高饱和商业滤镜，真实亲测感。
- 结构：展示 -> 痛点/对比 -> 使用质感 -> 效果展示 -> 收尾CTA。
- 镜头中景与特写交替，轻微手持律动，关键对比点可停留1-2秒。

4.6 故事讲述
- 使用 [Style] [Scene] [Cinematography] [Lighting & Color] [Mood & Tone] 模块化构建。
- 强调镜头连贯、人物情绪弧线、产品价值与场景关系，表达真诚可信。

输出前自检：
- 是否已明确主框架+辅助框架且可执行？
- 是否只聚焦1-2个核心卖点？
- 是否已体现时长与画幅约束？
- 是否包含声音、转场与CTA？
- 是否附带必须合规后缀？

最终说明：
确保每次输出都具备商业广告质感、真实可拍可剪、合规可信，并在4/6/8秒内形成有节奏的微故事。允许在合规前提下进行跨界创意与节奏创新。
""".strip()


# Shoplive brief/prompt helpers moved to `shoplive.backend.briefing`.
register_shoplive_routes(
    app,
    json_error=json_error,
    normalize_shoplive_brief=normalize_shoplive_brief,
    build_input_diff=build_input_diff,
    validate_shoplive_brief=validate_shoplive_brief,
    build_shoplive_script=build_shoplive_script,
    build_shoplive_script_prompt=build_shoplive_script_prompt,
    selfcheck_script=selfcheck_script,
    build_shoplive_video_prompt_template=build_shoplive_video_prompt_template,
    build_shoplive_agent_enhance_template=build_shoplive_agent_enhance_template,
    call_litellm_chat=call_litellm_chat,
    extract_chat_content=extract_chat_content,
    shoplive_video_system_prompt=SHOPLIVE_VIDEO_SYSTEM_PROMPT,
    default_video_duration=DEFAULT_VIDEO_DURATION,
)
register_agent_routes(
    app,
    json_error=json_error,
    parse_common_payload=parse_common_payload,
    get_access_token=get_access_token,
    build_proxies=build_proxies,
    normalize_reference_images_base64=normalize_reference_images_base64,
    normalize_reference_urls=normalize_reference_urls,
    fetch_image_as_base64=fetch_image_as_base64,
    extract_vertex_text=extract_vertex_text,
    try_parse_json_object=try_parse_json_object,
    call_litellm_chat=call_litellm_chat,
    extract_chat_content=extract_chat_content,
)
register_veo_routes(
    app,
    json_error=json_error,
    parse_common_payload=parse_common_payload,
    get_access_token=get_access_token,
    build_proxies=build_proxies,
    normalize_reference_urls=normalize_reference_urls,
    normalize_reference_images_base64=normalize_reference_images_base64,
    parse_data_url=parse_data_url,
    fetch_image_as_base64=fetch_image_as_base64,
    normalize_duration_seconds=normalize_duration_seconds,
    extract_gs_paths=extract_gs_paths,
    extract_inline_videos=extract_inline_videos,
    sign_gcs_url=sign_gcs_url,
)
register_media_routes(
    app,
    json_error=json_error,
    parse_common_payload=parse_common_payload,
    get_access_token=get_access_token,
    build_proxies=build_proxies,
    extract_banana_urls=extract_banana_urls,
    run_google_image_generate=run_google_image_generate,
    build_shoplive_image_prompt_compact=build_shoplive_image_prompt_compact,
    build_shoplive_image_prompt_safe_product_only=build_shoplive_image_prompt_safe_product_only,
    judge_generated_image_category=judge_generated_image_category,
)
register_video_edit_routes(
    app,
    json_error=json_error,
    build_proxies=build_proxies,
    parse_generic_data_url=parse_generic_data_url,
    escape_drawtext_text=escape_drawtext_text,
    download_video_to_file=download_video_to_file,
    video_edit_export_dir=VIDEO_EDIT_EXPORT_DIR,
)

@app.route("/")
def index():
    return send_from_directory(str(FRONTEND_PAGES_DIR), "index.html")


@app.route("/<path:asset_path>")
def serve_frontend_asset(asset_path: str):
    # Keep API routing explicit via /api/* handlers; this route serves frontend files only.
    if asset_path.startswith("api/"):
        return json_error("Not Found", 404)
    return send_from_directory(str(FRONTEND_ROOT), asset_path)


@app.route("/video-edits/<path:filename>")
def serve_video_edit_export(filename: str):
    return send_from_directory(str(VIDEO_EDIT_EXPORT_DIR), filename)


@app.before_request
def handle_options_preflight():
    if request.method == "OPTIONS":
        return ("", 204)


@app.after_request
def add_cors_headers(resp):
    resp.headers["Access-Control-Allow-Origin"] = "*"
    resp.headers["Access-Control-Allow-Headers"] = "Content-Type, Authorization"
    resp.headers["Access-Control-Allow-Methods"] = "GET, POST, OPTIONS"
    return resp


def create_app():
    return app


if __name__ == "__main__":
    port = int(os.getenv("PORT", "8000"))
    create_app().run(host="127.0.0.1", port=port, debug=True)
