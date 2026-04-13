import base64
import hashlib
import json
import logging
import os
import re
import tempfile
import time
from pathlib import Path
from typing import Callable, Dict, List, Tuple

from flask import g, jsonify

from shoplive.backend.audit import AuditedOp
from shoplive.backend.common.helpers import extract_vertex_text
from shoplive.backend.share_url_resolver import resolve_video_share_url
from shoplive.backend.scraper.fetchers import fetch_html_with_playwright
from shoplive.backend.schemas import HotVideoRemakeRequest
from shoplive.backend.validation import validate_request

logger = logging.getLogger(__name__)

_ASR_CACHE: Dict[tuple, tuple] = {}
_ASR_CACHE_TTL = 24 * 60 * 60
_ANALYSIS_CACHE: Dict[str, tuple] = {}
_ANALYSIS_CACHE_TTL = 15 * 60


def _resolve_share_url_with_render(video_url: str, proxy: str, timeout_seconds: int = 20) -> Dict[str, str]:
    return resolve_video_share_url(
        video_url,
        proxy=proxy,
        timeout_seconds=timeout_seconds,
        render_html=lambda page_url, page_proxy: fetch_html_with_playwright(
            page_url,
            page_proxy,
            platform="share_video",
            wait_ms=1800,
        ),
    )


def _normalize_text_list(value, limit: int) -> List[str]:
    if isinstance(value, list):
        items = value
    elif isinstance(value, str):
        items = re.split(r"[\n,;；，、]+", value)
    else:
        items = []
    out: List[str] = []
    for item in items:
        text = str(item or "").strip()
        if text and text not in out:
            out.append(text)
        if len(out) >= limit:
            break
    return out


def _normalize_product_anchors(value) -> Dict[str, object]:
    source = value if isinstance(value, dict) else {}
    return {
        "category": str(source.get("category") or "").strip(),
        "colors": _normalize_text_list(source.get("colors"), 6),
        "materials": _normalize_text_list(source.get("materials"), 6),
        "silhouette": str(source.get("silhouette") or "").strip(),
        "key_details": _normalize_text_list(source.get("key_details"), 8),
        "keep_elements": _normalize_text_list(source.get("keep_elements"), 8),
        "usage_scenarios": _normalize_text_list(source.get("usage_scenarios"), 6),
        "avoid_elements": _normalize_text_list(source.get("avoid_elements"), 6),
    }


def _subtitle_excerpt(subtitles: List[Dict], limit: int = 10) -> str:
    lines = []
    for item in (subtitles or [])[:limit]:
        start = round(float(item.get("start") or 0), 1)
        end = round(float(item.get("end") or 0), 1)
        text = str(item.get("text") or "").strip()
        if text:
            lines.append(f"[{start}-{end}] {text}")
    return "\n".join(lines)


def _clean_structure(structure, language: str) -> List[Dict[str, object]]:
    default_titles = ["开场钩子", "卖点展开", "转化收口"] if language == "zh" else ["Hook", "Body", "CTA"]
    items = structure if isinstance(structure, list) else []
    cleaned: List[Dict[str, object]] = []
    for idx, item in enumerate(items[:4]):
        if isinstance(item, str):
            cleaned.append({
                "title": item[:48],
                "summary": item,
                "beats": [item],
            })
            continue
        if not isinstance(item, dict):
            continue
        title = str(item.get("title") or item.get("stage") or default_titles[min(idx, len(default_titles) - 1)]).strip()
        summary = str(item.get("summary") or item.get("goal") or "").strip()
        beats = _normalize_text_list(item.get("beats"), 5)
        cleaned.append({
            "title": title,
            "summary": summary,
            "beats": beats,
        })
    return cleaned


def _clean_shot_plan(shot_plan, language: str, duration: int, hook: str, transcript: str) -> List[Dict[str, object]]:
    items = shot_plan if isinstance(shot_plan, list) else []
    cleaned: List[Dict[str, object]] = []
    for idx, item in enumerate(items[:6]):
        if not isinstance(item, dict):
            continue
        shot_title = str(item.get("shot") or item.get("title") or item.get("name") or "").strip()
        visual = str(item.get("visual") or item.get("scene") or "").strip()
        voiceover = str(item.get("voiceover") or item.get("narration") or "").strip()
        onscreen_text = str(item.get("onscreen_text") or item.get("caption") or "").strip()
        try:
            shot_duration = max(1, int(round(float(item.get("duration_seconds") or 0))))
        except Exception:
            shot_duration = 0
        cleaned.append({
            "shot": shot_title or (f"镜头{idx + 1}" if language == "zh" else f"Shot {idx + 1}"),
            "duration_seconds": shot_duration,
            "visual": visual,
            "voiceover": voiceover,
            "onscreen_text": onscreen_text,
        })
    if cleaned:
        return cleaned

    opening = hook or (_normalize_text_list(transcript, 1)[0] if transcript else "")
    fallback_titles = ["钩子", "卖点", "转化"] if language == "zh" else ["Hook", "Value", "CTA"]
    chunk = max(2, int(round((duration or 12) / 3)))
    return [
        {
            "shot": fallback_titles[0],
            "duration_seconds": chunk,
            "visual": "前三秒快速给出结果画面与强对比信息" if language == "zh" else "Open with a fast payoff visual and contrast.",
            "voiceover": opening,
            "onscreen_text": opening[:36],
        },
        {
            "shot": fallback_titles[1],
            "duration_seconds": chunk,
            "visual": "展示核心卖点与使用场景" if language == "zh" else "Show the core value and usage scenario.",
            "voiceover": transcript[:80],
            "onscreen_text": "核心卖点" if language == "zh" else "Core value",
        },
        {
            "shot": fallback_titles[2],
            "duration_seconds": max(2, int(duration or 12) - chunk * 2),
            "visual": "结尾强化信任与行动召唤" if language == "zh" else "End with trust and a clear CTA.",
            "voiceover": "现在下单/立即了解" if language == "zh" else "Shop now / learn more",
            "onscreen_text": "立即行动" if language == "zh" else "Act now",
        },
    ]


def _build_fallback_analysis(req_dict: Dict, subtitles: List[Dict], transcript: str, reason: str = "") -> Dict[str, object]:
    language = str(req_dict.get("language") or "zh")
    selling_points = _normalize_text_list(req_dict.get("selling_points"), 4)
    product_name = str(req_dict.get("product_name") or "").strip()
    goal = str(req_dict.get("remake_goal") or ("带货转化" if language == "zh" else "conversion")).strip()
    hook = ""
    if subtitles:
        hook = str(subtitles[0].get("text") or "").strip()
    elif transcript:
        hook = transcript.splitlines()[0][:60].strip()
    if not hook:
        hook = "先给结果，再解释为什么值得买" if language == "zh" else "Lead with the payoff, then explain why it matters."
    summary = (
        f"该参考视频更偏向“{goal}”导向，开头用强钩子抢注意力，中段快速推进卖点，结尾用明确 CTA 收口。"
        if language == "zh"
        else f"This reference video is optimized for {goal}, opening with a sharp hook, moving quickly through value beats, and closing with a direct CTA."
    )
    if product_name:
        summary += (
            f" 复刻时需要把商品主体替换为“{product_name}”。"
            if language == "zh"
            else f" Replace the hero product with {product_name} in the remake."
        )
    if selling_points:
        summary += (
            f" 建议重点承接卖点：{'、'.join(selling_points[:3])}。"
            if language == "zh"
            else f" Suggested carry-over value points: {', '.join(selling_points[:3])}."
        )
    voiceover_script = transcript or hook
    remake_script_lines = [
        "[脚本 A]" if int(req_dict.get("duration") or 16) >= 12 else "",
        f"镜头1：{hook}。前 2-3 秒直接给结果或反差画面。",
        f"镜头2：围绕“{product_name or '商品'}”展开 1-2 个核心卖点，结合真实使用场景。",
        "镜头3：用价格、痛点反转、前后对比或体验细节收口，并给出行动召唤。",
    ]
    remake_script = "\n".join([line for line in remake_script_lines if line])
    prompt_bits = [
        f"{product_name or 'Product'} hero video",
        f"goal: {goal}",
        f"hook: {hook}",
        f"selling points: {', '.join(selling_points[:3])}" if selling_points else "",
        f"target audience: {req_dict.get('target_user') or ''}",
        f"sales region: {req_dict.get('sales_region') or ''}",
        f"duration: {req_dict.get('duration') or 16}s",
        f"aspect ratio: {req_dict.get('aspect_ratio') or '16:9'}",
        "fast-cut commercial pacing, strong opening hook, concrete product close-ups, direct CTA",
    ]
    remake_prompt = ", ".join([bit for bit in prompt_bits if str(bit).strip()])
    structure = [
        {
            "title": "开场钩子" if language == "zh" else "Hook",
            "summary": hook,
            "beats": [hook],
        },
        {
            "title": "卖点推进" if language == "zh" else "Value beats",
            "summary": "围绕 1-2 个核心卖点快速推进" if language == "zh" else "Move quickly through 1-2 core value points.",
            "beats": selling_points[:3] or (["突出核心使用收益"] if language == "zh" else ["Highlight the key user payoff"]),
        },
        {
            "title": "转化收口" if language == "zh" else "CTA close",
            "summary": "结尾给出强 CTA 或信任锚点" if language == "zh" else "Close with a strong CTA or trust signal.",
            "beats": ["价格/口碑/限时行动"] if language == "zh" else ["Price / trust / urgency"],
        },
    ]
    shot_plan = _clean_shot_plan([], language, int(req_dict.get("duration") or 16), hook, transcript)
    return {
        "summary": summary,
        "hook": hook,
        "structure": structure,
        "shot_plan": shot_plan,
        "voiceover_script": voiceover_script,
        "remake_script": remake_script,
        "remake_prompt": remake_prompt,
        "analysis_notes": (
            f"fallback:{reason}" if reason else "fallback"
        ),
    }


def _normalize_analysis_payload(parsed: Dict, req_dict: Dict, subtitles: List[Dict], transcript: str, fallback_reason: str = "") -> Dict[str, object]:
    language = str(req_dict.get("language") or "zh")
    fallback = _build_fallback_analysis(req_dict, subtitles, transcript, fallback_reason)
    if not isinstance(parsed, dict) or not parsed:
        return fallback

    summary = str(parsed.get("summary") or fallback["summary"]).strip()
    hook = str(parsed.get("hook") or fallback["hook"]).strip()
    voiceover_script = str(parsed.get("voiceover_script") or parsed.get("subtitle_style") or fallback["voiceover_script"]).strip()
    remake_script = str(parsed.get("remake_script") or fallback["remake_script"]).strip()
    remake_prompt = str(parsed.get("remake_prompt") or fallback["remake_prompt"]).strip()
    analysis_notes = str(parsed.get("analysis_notes") or parsed.get("caution") or "").strip()
    structure = _clean_structure(parsed.get("structure"), language) or fallback["structure"]
    shot_plan = _clean_shot_plan(parsed.get("shot_plan"), language, int(req_dict.get("duration") or 16), hook, transcript)
    return {
        "summary": summary,
        "hook": hook,
        "structure": structure,
        "shot_plan": shot_plan,
        "voiceover_script": voiceover_script,
        "remake_script": remake_script,
        "remake_prompt": remake_prompt,
        "analysis_notes": analysis_notes,
    }


def _build_analysis_messages(req_dict: Dict, subtitles: List[Dict], transcript: str) -> List[Dict[str, str]]:
    language = str(req_dict.get("language") or "zh")
    product_context = {
        "product_name": req_dict.get("product_name") or "",
        "main_business": req_dict.get("main_business") or "",
        "selling_points": _normalize_text_list(req_dict.get("selling_points"), 6),
        "target_user": req_dict.get("target_user") or "",
        "sales_region": req_dict.get("sales_region") or "",
        "brand_direction": req_dict.get("brand_direction") or "",
        "product_anchors": _normalize_product_anchors(req_dict.get("product_anchors")),
        "remake_goal": req_dict.get("remake_goal") or "",
        "duration": req_dict.get("duration") or 16,
        "aspect_ratio": req_dict.get("aspect_ratio") or "16:9",
        "video_engine": req_dict.get("video_engine") or "veo",
    }
    schema_desc = {
        "summary": "string",
        "hook": "string",
        "structure": [{"title": "string", "summary": "string", "beats": ["string"]}],
        "shot_plan": [{"shot": "string", "duration_seconds": 3, "visual": "string", "voiceover": "string", "onscreen_text": "string"}],
        "voiceover_script": "string",
        "remake_script": "string",
        "remake_prompt": "string",
        "analysis_notes": "string",
    }
    system_prompt = (
        "你是短视频爆款拆解与复刻专家。"
        "请基于参考视频的字幕与用户商品信息，提炼真正可执行的复刻结构。"
        "默认输出“结构复刻 + 商品替换 + 文案改写”，不要逐字照搬原视频。"
        "必须只输出一个 JSON 对象，禁止输出 Markdown、解释或额外前后缀。"
        if language == "zh"
        else
        "You are an expert at breaking down viral short videos and turning them into executable remakes. "
        "Use the reference transcript and the user's product context to produce a structure-first remake package. "
        "Default to structure imitation plus rewritten copy rather than word-for-word copying. "
        "Return exactly one JSON object and nothing else."
    )
    user_payload = {
        "response_schema": schema_desc,
        "reference_video": {
            "subtitle_excerpt": _subtitle_excerpt(subtitles, 12),
            "transcript": transcript[:2200],
            "subtitle_count": len(subtitles),
        },
        "target_product": product_context,
        "requirements": {
            "language": language,
            "focus": [
                "3-second hook",
                "selling-point progression",
                "shot rhythm",
                "voiceover/subtitle style",
                "CTA ending",
            ],
            "must_keep": [
                "usable remake script",
                "engine-ready remake prompt",
                "clear shot plan",
                "safe rewritten copy",
            ],
        },
    }
    return [
        {"role": "system", "content": system_prompt},
        {"role": "user", "content": json.dumps(user_payload, ensure_ascii=False, indent=2)},
    ]


def _build_analysis_prompt(req_dict: Dict, subtitles: List[Dict], transcript: str) -> str:
    messages = _build_analysis_messages(req_dict, subtitles, transcript)
    return "\n\n".join(
        str(message.get("content") or "").strip()
        for message in messages
        if str(message.get("content") or "").strip()
    )


def _build_analysis_response_schema() -> Dict[str, object]:
    return {
        "type": "OBJECT",
        "properties": {
            "summary": {"type": "STRING"},
            "hook": {"type": "STRING"},
            "structure": {
                "type": "ARRAY",
                "items": {
                    "type": "OBJECT",
                    "properties": {
                        "title": {"type": "STRING"},
                        "summary": {"type": "STRING"},
                        "beats": {
                            "type": "ARRAY",
                            "items": {"type": "STRING"},
                        },
                    },
                },
            },
            "shot_plan": {
                "type": "ARRAY",
                "items": {
                    "type": "OBJECT",
                    "properties": {
                        "shot": {"type": "STRING"},
                        "duration_seconds": {"type": "NUMBER"},
                        "visual": {"type": "STRING"},
                        "voiceover": {"type": "STRING"},
                        "onscreen_text": {"type": "STRING"},
                    },
                },
            },
            "voiceover_script": {"type": "STRING"},
            "remake_script": {"type": "STRING"},
            "remake_prompt": {"type": "STRING"},
            "analysis_notes": {"type": "STRING"},
        },
    }


def _run_video_asr(
    payload: Dict,
    *,
    json_error: Callable[[str, int], Tuple],
    parse_common_payload: Callable[[Dict], Tuple[str, str, str, str]],
    get_access_token: Callable[[str, str, int], str],
    build_proxies: Callable[[str], Dict[str, str]],
    download_video_to_file: Callable[[str, Path, str], None],
    resolve_share_url: Callable[[str, str, int], Dict[str, str]],
):
    import requests as _req

    video_url = str(payload.get("video_url") or "").strip()
    language = str(payload.get("language") or "zh").strip().lower()
    max_lines = max(1, min(40, int(payload.get("max_lines") or 18)))
    cache_key = (hashlib.sha256(video_url.encode()).hexdigest()[:20], language, max_lines)
    cached = _ASR_CACHE.get(cache_key)
    if cached and time.time() - cached[2] < _ASR_CACHE_TTL:
        return {
            "ok": True,
            "subtitles": cached[0],
            "raw_text": cached[1],
            "cached": True,
            "resolved_video_url": video_url,
            "resolved_page_url": video_url,
            "share_resolution": {
                "input_url": video_url,
                "resolved_video_url": video_url,
                "resolved_page_url": video_url,
                "strategy": "cache_hit",
            },
        }
    if cached:
        _ASR_CACHE.pop(cache_key, None)

    project_id, key_file, proxy, _ = parse_common_payload(payload)
    resolution = resolve_share_url(video_url, proxy, 20)
    resolved_video_url = str(resolution.get("resolved_video_url") or video_url).strip() or video_url
    resolved_page_url = str(resolution.get("resolved_page_url") or resolved_video_url).strip() or resolved_video_url
    if str(resolution.get("strategy") or "").strip() == "unresolved_page":
        return json_error(
            (
                "当前分享链接暂未解析到可下载的视频直链，请改用公开视频链接、可直接下载的 mp4 链接，或稍后再试。"
                if language == "zh"
                else "This share page did not resolve to a downloadable video URL yet. Try an open video page, a direct mp4 link, or retry later."
            ),
            400,
        )
    try:
        with tempfile.TemporaryDirectory() as tmp_dir:
            tmp_path = Path(tmp_dir) / "hot_video_asr.mp4"
            download_video_to_file(resolved_video_url, tmp_path, proxy)
            video_bytes = tmp_path.read_bytes()
        if len(video_bytes) > 20 * 1024 * 1024:
            return json_error("视频文件过大（>20MB），暂不支持爆款视频解析", 400)

        token = get_access_token(key_file, proxy, 20)
        lang_name = "Chinese" if language == "zh" else "English"
        prompt = (
            f"Watch this short video carefully and produce timestamped subtitles in {lang_name}. "
            f"Return at most {max_lines} lines. "
            "Format each line exactly as: [START_SEC-END_SEC] TEXT\n"
            "Return only the timestamp lines. If there is no speech, return '无语音内容'."
        )
        video_b64 = base64.b64encode(video_bytes).decode("ascii")
        url = (
            f"https://aiplatform.googleapis.com/v1/projects/{project_id}"
            f"/locations/global/publishers/google/models/gemini-2.5-flash:generateContent"
        )
        body = {
            "contents": [{
                "role": "user",
                "parts": [
                    {"inline_data": {"mime_type": "video/mp4", "data": video_b64}},
                    {"text": prompt},
                ],
            }],
            "generation_config": {"temperature": 0.1, "max_output_tokens": 2048},
        }
        headers = {
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json; charset=utf-8",
        }
        resp = _req.post(url, json=body, headers=headers, proxies=build_proxies(proxy) or None, timeout=120)
        resp.raise_for_status()
        data = resp.json()
        raw_text = ""
        for cand in (data.get("candidates") or []):
            for part in (cand.get("content", {}).get("parts") or []):
                raw_text += part.get("text", "")

        line_pat = re.compile(r"\[(\d+(?:\.\d+)?)-(\d+(?:\.\d+)?)\]\s*(.+)")
        subtitles = []
        for line in raw_text.splitlines():
            match = line_pat.search(line.strip())
            if not match:
                continue
            start = float(match.group(1))
            end = float(match.group(2))
            text = match.group(3).strip()
            if end > start and text:
                subtitles.append({"start": start, "end": end, "text": text})
            if len(subtitles) >= max_lines:
                break
        _ASR_CACHE[cache_key] = (subtitles, raw_text, time.time())
        return {
            "ok": True,
            "subtitles": subtitles,
            "raw_text": raw_text,
            "cached": False,
            "resolved_video_url": resolved_video_url,
            "resolved_page_url": resolved_page_url,
            "share_resolution": resolution,
            "asr_error": "",
        }
    except Exception as exc:
        logger.warning("hot video ASR stage failed for %s: %s", video_url, exc)
        return {
            "ok": False,
            "subtitles": [],
            "raw_text": "",
            "cached": False,
            "resolved_video_url": resolved_video_url,
            "resolved_page_url": resolved_page_url,
            "share_resolution": resolution,
            "asr_error": str(exc),
        }


def register_hot_video_routes(
    app,
    *,
    json_error: Callable[[str, int], Tuple],
    parse_common_payload: Callable[[Dict], Tuple[str, str, str, str]],
    get_access_token: Callable[[str, str, int], str],
    build_proxies: Callable[[str], Dict[str, str]],
    download_video_to_file: Callable[[str, Path, str], None],
    call_litellm_chat: Callable[..., Tuple[int, Dict]],
    extract_chat_content: Callable[[Dict], str],
    try_parse_json_object: Callable[[str], Dict],
    resolve_share_url: Callable[[str, str, int], Dict[str, str]] = _resolve_share_url_with_render,
):
    @app.post("/api/hot-video/remake/analyze")
    @validate_request(HotVideoRemakeRequest)
    def api_hot_video_remake_analyze():
        req = g.req
        payload = req.model_dump()
        op = AuditedOp(
            "hot_video_remake",
            "analyze",
            {
                "video_url_len": len(str(payload.get("video_url") or "")),
                "product_name": str(payload.get("product_name") or "")[:80],
            },
        )
        asr_payload = dict(payload)
        subtitles: List[Dict] = []
        transcript = ""
        asr_cached = False
        asr_error = ""
        resolved_video_url = str(payload.get("video_url") or "").strip()
        resolved_page_url = resolved_video_url
        share_resolution = {
            "input_url": resolved_video_url,
            "resolved_video_url": resolved_video_url,
            "resolved_page_url": resolved_page_url,
            "strategy": "passthrough",
        }
        try:
            asr_result = _run_video_asr(
                asr_payload,
                json_error=json_error,
                parse_common_payload=parse_common_payload,
                get_access_token=get_access_token,
                build_proxies=build_proxies,
                download_video_to_file=download_video_to_file,
                resolve_share_url=resolve_share_url,
            )
            if isinstance(asr_result, tuple):
                return asr_result
            subtitles = asr_result.get("subtitles") or []
            transcript = str(asr_result.get("raw_text") or "").strip()
            asr_cached = bool(asr_result.get("cached"))
            asr_error = str(asr_result.get("asr_error") or "").strip()
            resolved_video_url = str(asr_result.get("resolved_video_url") or resolved_video_url).strip() or resolved_video_url
            resolved_page_url = str(asr_result.get("resolved_page_url") or resolved_page_url).strip() or resolved_page_url
            share_resolution = asr_result.get("share_resolution") if isinstance(asr_result.get("share_resolution"), dict) else share_resolution
        except Exception as exc:
            asr_error = str(exc)
            logger.warning("hot video ASR failed: %s", exc)

        cache_key = hashlib.sha256(
            json.dumps(
                {
                    "video_url": payload.get("video_url"),
                    "language": payload.get("language"),
                    "duration": payload.get("duration"),
                    "aspect_ratio": payload.get("aspect_ratio"),
                    "video_engine": payload.get("video_engine"),
                    "product_name": payload.get("product_name"),
                    "selling_points": payload.get("selling_points"),
                    "target_user": payload.get("target_user"),
                    "sales_region": payload.get("sales_region"),
                    "brand_direction": payload.get("brand_direction"),
                    "product_anchors": _normalize_product_anchors(payload.get("product_anchors")),
                    "transcript": transcript[:2000],
                },
                ensure_ascii=False,
                sort_keys=True,
            ).encode("utf-8")
        ).hexdigest()
        cached_analysis = _ANALYSIS_CACHE.get(cache_key)
        if cached_analysis and time.time() - cached_analysis[1] < _ANALYSIS_CACHE_TTL:
            analysis = cached_analysis[0]
            source = "vertex_cached"
        else:
            analysis = {}
            source = "fallback"
            proxy = str(payload.get("proxy") or "").strip()
            try:
                import requests as _req

                project_id, key_file, _proxy, _ = parse_common_payload(payload)
                model = (
                    payload.get("model")
                    or os.getenv("HOT_VIDEO_ANALYSIS_MODEL")
                    or "gemini-2.5-flash"
                ).strip()
                location = str(payload.get("location") or "global").strip()
                token = get_access_token(key_file, proxy, 20)
                url = (
                    f"https://aiplatform.googleapis.com/v1/projects/{project_id}"
                    f"/locations/{location}/publishers/google/models/{model}:generateContent"
                )
                resp = _req.post(
                    url,
                    headers={
                        "Authorization": f"Bearer {token}",
                        "Content-Type": "application/json; charset=utf-8",
                    },
                    json={
                        "contents": [{
                            "role": "user",
                            "parts": [{"text": _build_analysis_prompt(payload, subtitles, transcript)}],
                        }],
                        "generationConfig": {
                            "temperature": 0.2,
                            "maxOutputTokens": 4096,
                            "responseMimeType": "application/json",
                            "responseSchema": _build_analysis_response_schema(),
                        },
                    },
                    proxies=build_proxies(proxy) or None,
                    timeout=120,
                )
                resp.raise_for_status()
                raw_content = extract_vertex_text(resp.json())
                parsed = try_parse_json_object(raw_content)
                analysis = _normalize_analysis_payload(parsed, payload, subtitles, transcript, asr_error)
                source = "vertex"
                _ANALYSIS_CACHE[cache_key] = (analysis, time.time())
            except Exception as exc:
                analysis = _build_fallback_analysis(payload, subtitles, transcript, str(exc))

        if not analysis:
            analysis = _build_fallback_analysis(payload, subtitles, transcript, asr_error or "empty_analysis")

        op.success({
            "subtitle_count": len(subtitles),
            "source": source,
            "asr_cached": asr_cached,
            "share_strategy": str(share_resolution.get("strategy") or ""),
        })
        return jsonify({
            "ok": True,
            "source": source,
            "asr_cached": asr_cached,
            "asr_error": asr_error,
            "summary": analysis.get("summary", ""),
            "hook": analysis.get("hook", ""),
            "structure": analysis.get("structure", []),
            "shot_plan": analysis.get("shot_plan", []),
            "voiceover_script": analysis.get("voiceover_script", ""),
            "remake_script": analysis.get("remake_script", ""),
            "remake_prompt": analysis.get("remake_prompt", ""),
            "analysis_notes": analysis.get("analysis_notes", ""),
            "asr_subtitles": subtitles,
            "transcript": transcript,
            "resolved_video_url": resolved_video_url,
            "resolved_page_url": resolved_page_url,
            "share_resolution": share_resolution,
            "analysis": analysis,
        })
