import re
from typing import Dict, List


ALLOWED_VIDEO_DURATIONS = {4, 6, 8, 10, 11, 12, 13, 14, 15}
ALLOWED_TOTAL_VIDEO_DURATIONS = {4, 6, 8, 10, 11, 12, 13, 14, 15, 16, 24}
DEFAULT_VIDEO_DURATION = 8


def normalize_selling_points(raw: str) -> List[str]:
    points = [x.strip() for x in re.split(r"[，,、;；\n]+", str(raw or "")) if x.strip()]
    return list(dict.fromkeys(points))


def _normalize_list(raw, limit: int = 6) -> List[str]:
    if isinstance(raw, list):
        vals = [str(x or "").strip() for x in raw if str(x or "").strip()]
    else:
        vals = [x.strip() for x in re.split(r"[，,、;；\n]+", str(raw or "")) if x.strip()]
    return list(dict.fromkeys(vals))[:limit]


def normalize_product_anchors(raw) -> Dict:
    payload = raw if isinstance(raw, dict) else {}
    return {
        "category": str(payload.get("category", "") or "").strip(),
        "colors": _normalize_list(payload.get("colors"), 5),
        "materials": _normalize_list(payload.get("materials"), 5),
        "silhouette": str(payload.get("silhouette", "") or "").strip(),
        "key_details": _normalize_list(payload.get("key_details"), 6),
        "keep_elements": _normalize_list(payload.get("keep_elements"), 6),
        "usage_scenarios": _normalize_list(payload.get("usage_scenarios"), 4),
        "avoid_elements": _normalize_list(payload.get("avoid_elements"), 4),
    }


def render_product_anchor_text(anchors: Dict, *, lang: str = "zh") -> str:
    normalized = normalize_product_anchors(anchors)
    lines = []
    if normalized["category"]:
        lines.append(f"商品子类：{normalized['category']}" if lang == "zh" else f"Category: {normalized['category']}")
    if normalized["colors"]:
        lines.append(
            f"核心颜色：{'、'.join(normalized['colors'])}"
            if lang == "zh" else f"Core colors: {', '.join(normalized['colors'])}"
        )
    if normalized["materials"]:
        lines.append(
            f"核心材质：{'、'.join(normalized['materials'])}"
            if lang == "zh" else f"Core materials: {', '.join(normalized['materials'])}"
        )
    if normalized["silhouette"]:
        lines.append(f"轮廓版型：{normalized['silhouette']}" if lang == "zh" else f"Silhouette: {normalized['silhouette']}")
    if normalized["key_details"]:
        lines.append(
            f"关键细节：{'、'.join(normalized['key_details'])}"
            if lang == "zh" else f"Key details: {', '.join(normalized['key_details'])}"
        )
    if normalized["keep_elements"]:
        lines.append(
            f"必须保留：{'、'.join(normalized['keep_elements'])}"
            if lang == "zh" else f"Must keep: {', '.join(normalized['keep_elements'])}"
        )
    if normalized["usage_scenarios"]:
        lines.append(
            f"适用场景：{'、'.join(normalized['usage_scenarios'])}"
            if lang == "zh" else f"Use scenarios: {', '.join(normalized['usage_scenarios'])}"
        )
    if normalized["avoid_elements"]:
        lines.append(
            f"禁止偏移到：{'、'.join(normalized['avoid_elements'])}"
            if lang == "zh" else f"Do not drift to: {', '.join(normalized['avoid_elements'])}"
        )
    return "；".join(lines) if lang == "zh" else ". ".join(lines)


def normalize_duration_seconds(raw) -> int:
    try:
        n = int(raw)
    except Exception:
        return DEFAULT_VIDEO_DURATION
    return n if n in ALLOWED_VIDEO_DURATIONS else DEFAULT_VIDEO_DURATION


def normalize_total_duration_seconds(raw) -> int:
    try:
        n = int(raw)
    except Exception:
        return DEFAULT_VIDEO_DURATION
    return n if n in ALLOWED_TOTAL_VIDEO_DURATIONS else DEFAULT_VIDEO_DURATION


def normalize_shoplive_brief(payload: Dict) -> Dict:
    selling_points = normalize_selling_points(payload.get("selling_points", ""))
    raw_total_duration = payload.get("total_duration", payload.get("duration", DEFAULT_VIDEO_DURATION))
    total_duration = normalize_total_duration_seconds(raw_total_duration)
    duration = normalize_duration_seconds(payload.get("duration", total_duration))
    raw_aspect_ratio = str(payload.get("aspect_ratio", "16:9") or "16:9").strip() or "16:9"
    _VALID_RATIOS = {"16:9", "9:16", "1:1"}
    aspect_ratio = raw_aspect_ratio if raw_aspect_ratio in _VALID_RATIOS else "16:9"
    aspect_ratio_overridden = raw_aspect_ratio not in _VALID_RATIOS and raw_aspect_ratio != "16:9"
    product_name = str(payload.get("product_name", "") or "").strip()
    main_category = str(payload.get("main_category", payload.get("main_business", "")) or "").strip()
    template = str(payload.get("template", payload.get("style_template", "clean")) or "clean").strip() or "clean"
    brand_direction = str(payload.get("brand_direction", "") or "").strip()
    image_count_raw = payload.get("image_count", 0)
    try:
        image_count = int(image_count_raw or 0)
    except Exception:
        image_count = 0
    product_anchors = normalize_product_anchors(payload.get("product_anchors", {}))
    return {
        "product_name": product_name,
        "main_category": main_category,
        "selling_points": selling_points[:6],
        "target_user": str(payload.get("target_user", "")).strip(),
        "sales_region": str(payload.get("sales_region", "")).strip(),
        "template": template,
        "brand_direction": brand_direction,
        "duration": duration,
        "total_duration": total_duration,
        "aspect_ratio": aspect_ratio,
        "need_model": bool(payload.get("need_model", True)),
        "image_count": max(0, image_count),
        "product_anchors": product_anchors,
        "quality_reports": payload.get("quality_reports", [])
        if isinstance(payload.get("quality_reports", []), list)
        else [],
        "aspect_ratio_warning": (
            f"aspect_ratio '{raw_aspect_ratio}' 不支持（仅 16:9 / 9:16 / 1:1），已自动设为 '16:9'"
            if aspect_ratio_overridden else ""
        ),
    }


def build_input_diff(raw: Dict, normalized: Dict) -> Dict:
    diff = {}
    raw_sp = normalize_selling_points(raw.get("selling_points", ""))
    if raw_sp[:6] != normalized["selling_points"]:
        diff["selling_points"] = {"raw": raw_sp, "effective": normalized["selling_points"]}
    raw_duration = normalize_duration_seconds(raw.get("duration", DEFAULT_VIDEO_DURATION))
    if raw_duration != normalized["duration"]:
        diff["duration"] = {"raw": raw_duration, "effective": normalized["duration"]}
    raw_total_duration = normalize_total_duration_seconds(raw.get("total_duration", raw.get("duration", DEFAULT_VIDEO_DURATION)))
    if raw_total_duration != normalized.get("total_duration", DEFAULT_VIDEO_DURATION):
        diff["total_duration"] = {"raw": raw_total_duration, "effective": normalized.get("total_duration", DEFAULT_VIDEO_DURATION)}
    raw_aspect = str(raw.get("aspect_ratio", "16:9") or "16:9").strip() or "16:9"
    if raw_aspect != normalized["aspect_ratio"]:
        diff["aspect_ratio"] = {"raw": raw_aspect, "effective": normalized["aspect_ratio"]}
    return diff


def validate_shoplive_brief(brief: Dict) -> Dict:
    issues = []
    image_count = int(brief.get("image_count", 0) or 0)
    if image_count <= 0:
        issues.append("NO_IMAGES")
    if image_count > 3:
        issues.append("TOO_MANY_IMAGES")
    for q in brief.get("quality_reports", []):
        w = int(q.get("width", 0) or 0)
        h = int(q.get("height", 0) or 0)
        sharp = float(q.get("sharpness", 0) or 0)
        subject = float(q.get("subjectRatio", q.get("subject_ratio", 0)) or 0)
        is_generated = bool(q.get("is_generated", False))
        if w <= 0 or h <= 0:
            continue
        if (w < 1024 or h < 1024) and not is_generated:
            issues.append("LOW_RESOLUTION")
            break
        if sharp < 100:
            issues.append("LOW_SHARPNESS")
            break
        if subject < 0.4:
            issues.append("LOW_SUBJECT")
            break
    if len(brief.get("selling_points", [])) == 0:
        issues.append("NEED_SELLING_POINTS")
    if len(brief.get("selling_points", [])) > 6:
        issues.append("TOO_MANY_POINTS")
    if not brief.get("target_user"):
        issues.append("NEED_TARGET_USER")
    if not brief.get("sales_region"):
        issues.append("NEED_REGION")
    ok = len(issues) == 0
    return {"ok": ok, "issues": issues}


def build_shoplive_script(brief: Dict) -> str:
    points = [str(x or "").strip() for x in brief.get("selling_points", []) if str(x or "").strip()]
    p0 = points[0] if points else "核心卖点"
    p1 = points[1] if len(points) > 1 else p0
    duration = int(brief.get("duration", DEFAULT_VIDEO_DURATION) or DEFAULT_VIDEO_DURATION)
    total_duration = int(brief.get("total_duration", duration) or duration)
    aspect = str(brief.get("aspect_ratio", "16:9") or "16:9")
    target = str(brief.get("target_user") or "目标用户")
    region = str(brief.get("sales_region") or "目标地区")
    product = str(brief.get("product_name") or "该商品")
    template = str(brief.get("template") or "clean")
    brand_direction = str(brief.get("brand_direction") or "默认品牌表达")
    model_text = "需要模特展示" if bool(brief.get("need_model", True)) else "不需要模特展示"
    anchor_text = render_product_anchor_text(brief.get("product_anchors", {}), lang="zh")
    return (
        f"主框架：4.4 产品演示；辅助框架：4.6 故事讲述\n"
        f"镜头1（0-2s）：{aspect}构图，{product}开场特写，突出{p0}，电影级影棚布光，镜头推近。{'商品锚点：' + anchor_text + '。' if anchor_text else ''}\n"
        f"镜头2（2-5s）：{model_text}，在{region}偏好场景面向{target}进行使用演示，展示{p1}，镜头跟拍并加入情绪锚点，品牌调性贴合“{brand_direction}”。\n"
        f"镜头3（5-{duration}s）：收束为转化镜头，保留商品关键细节与购买动机，禁止换品类、换轮廓、换材质，节奏干净利落。\n"
        + (f"链路时长：目标总时长 {total_duration}s（通过 8s 分段自动延展）。\n" if total_duration in {16, 24} else "")
        + f"BGM：轻快且有节奏感的电商氛围音乐，避免喧宾夺主。\n"
        + f"标题：{product}｜{duration}s 高转化短视频（{template}）\n"
        + f"文案：围绕“{('；'.join(points) if points else p0)}”做真实可执行表达，不夸大、不绝对化。\n"
        + "合规检查：高光边缘干净，反光可控，材质纹理清晰，结构边缘锐利，不出现畸形手或错误结构，不出现他牌标识或水印。"
    )


def build_shoplive_script_prompt(brief: Dict, user_message: str = "") -> str:
    points = "；".join([str(x or "").strip() for x in brief.get("selling_points", []) if str(x or "").strip()]) or "核心卖点"
    model_text = "需要模特展示" if bool(brief.get("need_model", True)) else "不需要模特展示"
    extra = str(user_message or "").strip()
    total_duration = int(brief.get("total_duration", brief.get("duration", DEFAULT_VIDEO_DURATION)) or DEFAULT_VIDEO_DURATION)
    anchor_text = render_product_anchor_text(brief.get("product_anchors", {}), lang="zh")
    return (
        "你是电商短视频脚本导演。请按“最新规则”输出可直接执行的脚本，不要解释。\n"
        + "必须遵循：优先聚焦1-2个核心卖点；框架4.1~4.6中选择1个主框架+1个辅助框架；镜头连贯、可拍摄、可剪辑。\n"
        + f"商品：{brief.get('product_name', '') or '该商品'}\n"
        + (f"商品锚点：{anchor_text}\n" if anchor_text else "")
        + f"卖点：{points}\n"
        + f"目标用户：{brief.get('target_user', '') or '目标用户'}\n"
        + f"销售地区：{brief.get('sales_region', '') or '目标地区'}\n"
        + f"模板风格：{brief.get('template', 'clean')}\n"
        + f"品牌方向：{brief.get('brand_direction', '') or '默认品牌表达'}\n"
        + f"单段时长：{brief.get('duration', DEFAULT_VIDEO_DURATION)}秒（4/6/8之一）\n"
        + f"目标总时长：{total_duration}秒（可选16/24，按8秒链式延展）\n"
        + f"画幅：{brief.get('aspect_ratio', '16:9')}\n"
        + f"模特策略：{model_text}\n"
        + f"用户补充：{extra or '无'}\n"
        + "如果给了商品锚点，必须锁定品类、颜色族、材质、轮廓和关键结构，不得漂移到其他商品。\n"
        + "输出格式必须包含以下字段并按顺序输出：\n"
        + "主框架：...\n"
        + "辅助框架：...\n"
        + "镜头1（含时段）：...\n"
        + "镜头2（含时段）：...\n"
        + "镜头3（含时段）：...\n"
        + "Bgm：...\n"
        + "标题：...\n"
        + "文案：...\n"
        + "合规检查：高光边缘干净，反光可控，材质纹理清晰，结构边缘锐利，不出现畸形手或错误结构，不出现他牌标识或水印。"
    )


def selfcheck_script(script_text: str) -> Dict:
    text = str(script_text or "")
    missing = []
    if not (
        re.search(r"镜头1|shot\s*1", text, re.IGNORECASE)
        and re.search(r"镜头2|shot\s*2", text, re.IGNORECASE)
        and re.search(r"镜头3|shot\s*3", text, re.IGNORECASE)
    ):
        missing.append("SHOT_1_2_3")
    if not re.search(r"bgm", text, re.IGNORECASE):
        missing.append("BGM")
    if not re.search(r"标题|title", text, re.IGNORECASE):
        missing.append("TITLE")
    if not re.search(r"文案|copy|caption", text, re.IGNORECASE):
        missing.append("COPY")
    return {"ok": len(missing) == 0, "missing": missing}


def build_shoplive_video_prompt_template(normalized: Dict, script_text: str) -> str:
    points = [str(x or "").strip() for x in normalized.get("selling_points", []) if str(x or "").strip()]
    points_text = "；".join(points) if points else "核心卖点"
    target_user = normalized.get("target_user", "") or "目标用户"
    region = normalized.get("sales_region", "") or "目标地区"
    template = normalized.get("template", "clean")
    product = normalized.get("product_name", "") or "该商品"
    duration = int(normalized.get("duration", DEFAULT_VIDEO_DURATION) or DEFAULT_VIDEO_DURATION)
    total_duration = int(normalized.get("total_duration", duration) or duration)
    aspect = normalized.get("aspect_ratio", "16:9") or "16:9"
    need_model = "需要模特展示" if bool(normalized.get("need_model", True)) else "不需要模特展示"
    script_hint = str(script_text or "").strip()[:600]
    anchor_text = render_product_anchor_text(normalized.get("product_anchors", {}), lang="zh")
    brand_direction = normalized.get("brand_direction", "") or "默认品牌表达"
    return (
        f"{aspect} 超高清商业画质，电影级影棚布光。"
        f"商品：{product}。主卖点仅聚焦1-2个：{points_text}。"
        f"目标人群：{target_user}；销售地区：{region}；风格模板：{template}；品牌方向：{brand_direction}；模特策略：{need_model}；单段时长：{duration}秒。"
        + (f" 目标总时长：{total_duration}秒（通过8秒分段延展）。" if total_duration in {16, 24} else "")
        + (f" 商品锚点：{anchor_text}。" if anchor_text else "")
        + "镜头组织遵循动态节奏，优先使用 1 个主框架 + 1 个辅助框架（4.1~4.6），"
        + "把卖点转化为可执行镜头动作、光影、环境与情绪锚点，不写空话。必须严格保持商品颜色、材质、轮廓与关键结构一致，禁止漂移到其他品类。"
        + (f" 参考分镜脚本：{script_hint}。" if script_hint else "")
        + " 合规后缀：高光边缘干净，反光可控，材质纹理清晰，结构边缘锐利，不出现畸形手或错误结构，不出现他牌标识或水印。"
    )


def build_shoplive_agent_enhance_template(normalized: Dict, raw_prompt: str = "", script_text: str = "") -> str:
    points = normalized.get("selling_points", []) or []
    points_text = "；".join(points) if points else "突出核心卖点"
    product = normalized.get("product_name", "") or "该商品"
    target_user = normalized.get("target_user", "") or "目标用户"
    region = normalized.get("sales_region", "") or "目标地区"
    template = normalized.get("template", "clean") or "clean"
    duration = int(normalized.get("duration", DEFAULT_VIDEO_DURATION) or DEFAULT_VIDEO_DURATION)
    total_duration = int(normalized.get("total_duration", duration) or duration)
    aspect = normalized.get("aspect_ratio", "16:9") or "16:9"
    story_hint = str(script_text or "").strip()[:500]
    base_prompt = str(raw_prompt or "").strip()
    anchor_text = render_product_anchor_text(normalized.get("product_anchors", {}), lang="zh")
    brand_direction = normalized.get("brand_direction", "") or "默认品牌表达"
    return (
        "你是一位电商视频提示词优化专家。请把用户原始提示词改写为一条可直接用于视频生成的最终提示词。\n"
        + "你必须严格遵循如下视频 prompt 框架，并按框架字段组织语义：\n"
        + "4.1 产品口播：\n"
        + "- [Style] [Environment] [Tone & Pacing] [Camera] [Lighting]\n"
        + "- [Actions/Scenes]：主体动作 -> 产品特写 -> 使用演示 -> 情绪展示 -> 收尾\n"
        + "- [Background Sound] [Transition/Editing] [Call to Action]\n"
        + "4.2 UGC评测：\n"
        + "- 真实手持/POV、快节奏、生活化高代入\n"
        + "- 结构：主体出场 -> 产品特写 -> 使用演示 -> 前后对比(可选) -> 总结推荐\n"
        + "4.3 痛点与解决：\n"
        + "- Shot1 正确示范 -> Shot2 痛点示范 -> Shot3 解决细节 -> Shot4 性能特写 -> Shot5 推荐收尾\n"
        + "4.4 产品演示：\n"
        + "- 极简电影感写实，强调流程可视化与日常仪式感\n"
        + "- 结构：产品引入 -> 使用动作 -> 特写卖点 -> 体验展示 -> 收尾CTA\n"
        + "4.5 前后对比：\n"
        + "- 现代达人带货风格，高饱和商业滤镜，真实亲测感\n"
        + "- 结构：展示 -> 痛点/对比 -> 使用质感 -> 效果展示 -> 收尾CTA\n"
        + "4.6 故事讲述：\n"
        + "- [Style] [Scene] [Cinematography] [Lighting & Color] [Mood & Tone]\n"
        + "- 叙事强调镜头连贯、情绪弧线、产品价值与场景关系\n"
        + "根据商品与卖点自动选择最合适的1种主框架 + 1种辅助框架，不要同时铺满所有框架。\n"
        + f"约束：单段时长={duration}秒，目标总时长={total_duration}秒，画幅={aspect}，商品={product}，目标人群={target_user}，地区={region}，风格模板={template}，品牌方向={brand_direction}。\n"
        + f"核心卖点：{points_text}。\n"
        + (f"商品锚点：{anchor_text}\n" if anchor_text else "")
        + (f"参考分镜：{story_hint}\n" if story_hint else "")
        + (f"用户原始提示词：{base_prompt}\n" if base_prompt else "用户原始提示词：无\n")
        + "输出要求：\n"
        + "- 只输出最终一条提示词正文，不要解释。\n"
        + "- 优先保证商品一致性、真实感、镜头可执行性。若给了商品锚点，必须锁定颜色、材质、轮廓和关键细节，不得改成其他品类。\n"
        + "- 最终提示词中要显式覆盖：Style/Environment/Tone & Pacing/Camera/Lighting/Actions/Background Sound/Transition/CTA。\n"
        + "- 单段时长是4/6/8秒；若总时长是16/24秒，按8秒片段链式延展。卖点只聚焦1-2个，节奏要可拍可剪。\n"
        + "- 必须包含合规后缀：高光边缘干净，反光可控，材质纹理清晰，结构边缘锐利，不出现畸形手或错误结构，不出现他牌标识或水印。"
    )

