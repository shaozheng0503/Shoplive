import hashlib
import json
import os
from typing import Callable, Dict, Tuple

from flask import jsonify, request

from shoplive.backend.async_executor import _TTLCache

# 5-min LLM response cache: key = (input_fingerprint, action, model)
# Avoids re-calling LLM for identical brief + action within the same session.
_llm_response_cache = _TTLCache(ttl_seconds=300, max_size=200)


def _build_shoplive_script_via_llm(
    *,
    normalized: Dict,
    user_message: str,
    api_base: str,
    api_key: str,
    model: str,
    proxy: str,
    build_shoplive_script_prompt: Callable[[Dict, str], str],
    call_litellm_chat: Callable[..., Tuple[int, Dict]],
) -> Tuple[int, Dict]:
    messages = [
        {
            "role": "system",
            "content": (
                "你是电商视频脚本专家。"
                "严格遵循最新规则：只聚焦1-2个核心卖点，必须从4.1~4.6中选择1个主框架+1个辅助框架，"
                "镜头可执行、节奏清晰、真实合规。"
                "只输出脚本正文，不要解释。"
            ),
        },
        {"role": "user", "content": build_shoplive_script_prompt(normalized, user_message)},
    ]
    status_code, data_wrap = call_litellm_chat(
        api_base=api_base,
        api_key=api_key,
        model=model,
        messages=messages,
        proxy=proxy,
        temperature=0.6,
        max_tokens=900,
    )
    return status_code, data_wrap


def _build_shoplive_video_prompt_via_llm(
    *,
    normalized: Dict,
    script_text: str,
    api_base: str,
    api_key: str,
    model: str,
    proxy: str,
    shoplive_video_system_prompt: str,
    call_litellm_chat: Callable[..., Tuple[int, Dict]],
) -> Tuple[int, Dict]:
    selling_points = [str(x or "").strip() for x in normalized.get("selling_points", []) if str(x or "").strip()]
    aspect_ratio = str(normalized.get("aspect_ratio", "16:9") or "16:9").strip()
    duration = int(normalized.get("duration", 8) or 8)
    need_model = bool(normalized.get("need_model", True))
    script_excerpt = str(script_text or "").strip()
    user_payload = {
        "product_name": normalized.get("product_name", ""),
        "main_category": normalized.get("main_category", ""),
        "core_selling_points": selling_points,
        "core_selling_points_text": "；".join(selling_points),
        "primary_scene": normalized.get("template", "clean"),
        "fallback_scene": "studio still-life background",
        "selling_region": normalized.get("sales_region", ""),
        "target_audience": normalized.get("target_user", ""),
        "brand_philosophy": normalized.get("brand_direction", "") or "Shoplive conversion-first ecommerce storytelling",
        "duration_seconds": duration,
        "aspect_ratio": aspect_ratio,
        "need_model_showcase": need_model,
        "input_storyboard": script_excerpt,
        "constraints": {
            "duration_seconds_must_be": duration,
            "aspect_ratio_must_be": aspect_ratio,
            "output_language": "zh",
            "output_format": "only final usable video prompt text, no explanation",
        },
    }
    messages = [
        {"role": "system", "content": shoplive_video_system_prompt},
        {
            "role": "user",
            "content": (
                "请根据以下结构化输入生成最终视频提示词。"
                "必须严格遵守输入中的时长与画幅，并充分利用 input_storyboard。"
                "必须遵循最新规则：聚焦1-2个核心卖点；从4.1~4.6中选1个主框架+1个辅助框架；"
                "输出应包含可执行镜头、光影、场景、情绪锚点与合规后缀。"
                "只输出最终可直接用于视频生成的一段提示词，不要解释。\n"
                + json.dumps(user_payload, ensure_ascii=False, indent=2)
            ),
        },
    ]
    status_code, data_wrap = call_litellm_chat(
        api_base=api_base,
        api_key=api_key,
        model=model,
        messages=messages,
        proxy=proxy,
        temperature=0.5,
        max_tokens=900,
    )
    return status_code, data_wrap


def register_shoplive_routes(
    app,
    *,
    json_error: Callable[[str, int], Tuple],
    normalize_shoplive_brief: Callable[[Dict], Dict],
    build_input_diff: Callable[[Dict, Dict], Dict],
    validate_shoplive_brief: Callable[[Dict], Dict],
    build_shoplive_script: Callable[[Dict], str],
    build_shoplive_script_prompt: Callable[[Dict, str], str],
    selfcheck_script: Callable[[str], Dict],
    build_shoplive_video_prompt_template: Callable[[Dict, str], str],
    build_shoplive_agent_enhance_template: Callable[[Dict, str, str], str],
    call_litellm_chat: Callable[..., Tuple[int, Dict]],
    extract_chat_content: Callable[[Dict], str],
    shoplive_video_system_prompt: str,
    default_video_duration: int,
):
    @app.post("/api/shoplive/video/prompt")
    def api_shoplive_video_prompt():
        payload = request.get_json(silent=True) or {}
        try:
            api_base = (
                payload.get("api_base")
                or os.getenv("LITELLM_API_BASE")
                or "https://litellm.shoplazza.site"
            ).strip().rstrip("/")
            api_key = (payload.get("api_key") or os.getenv("LITELLM_API_KEY") or "").strip()
            model = (payload.get("model") or os.getenv("LITELLM_MODEL") or "azure-gpt-5").strip()
            proxy = (payload.get("proxy") or "").strip()
            if not api_key:
                return json_error("video prompt api_key 不能为空（可通过 payload.api_key 或 LITELLM_API_KEY 提供）")

            normalized = normalize_shoplive_brief(
                {
                    "product_name": payload.get("product_name", ""),
                    "main_category": payload.get("main_category", ""),
                    "selling_points": payload.get("core_selling_points", ""),
                    "target_user": payload.get("target_audience", ""),
                    "sales_region": payload.get("selling_region", ""),
                    "template": payload.get("primary_scene", "clean"),
                    "duration": payload.get("duration_seconds", default_video_duration),
                    "aspect_ratio": payload.get("aspect_ratio", "16:9"),
                    "need_model": True,
                    "image_count": 1,
                    "quality_reports": [],
                }
            )
            requested_duration_seconds = payload.get("duration_seconds")
            status_code, data_wrap = _build_shoplive_video_prompt_via_llm(
                normalized=normalized,
                script_text=str(payload.get("other_info", "") or ""),
                api_base=api_base,
                api_key=api_key,
                model=model,
                proxy=proxy,
                shoplive_video_system_prompt=shoplive_video_system_prompt,
                call_litellm_chat=call_litellm_chat,
            )
            data = data_wrap.get("response", {})
            content = extract_chat_content(data)
            return jsonify(
                {
                    "ok": data_wrap.get("ok", False),
                    "status_code": status_code,
                    "model": model,
                    "prompt": content,
                    "requested_duration_seconds": requested_duration_seconds,
                    "effective_duration_seconds": normalized.get("duration", default_video_duration),
                    "response": data,
                }
            ), status_code
        except Exception as e:
            return json_error(f"Shoplive 视频提示词生成失败: {e}", 500)

    @app.post("/api/shoplive/video/workflow")
    def api_shoplive_video_workflow():
        payload = request.get_json(silent=True) or {}
        try:
            action = str(payload.get("action", "generate_script")).strip()
            raw_input = payload.get("input", {}) if isinstance(payload.get("input"), dict) else {}
            normalized = normalize_shoplive_brief(raw_input)
            input_diff = build_input_diff(raw_input, normalized)
            validation = validate_shoplive_brief(normalized)
            input_fingerprint = hashlib.sha256(str(normalized).encode("utf-8")).hexdigest()[:16]
            api_base = (
                payload.get("api_base")
                or os.getenv("LITELLM_API_BASE")
                or "https://litellm.shoplazza.site"
            ).strip().rstrip("/")
            api_key = (payload.get("api_key") or os.getenv("LITELLM_API_KEY") or "").strip()
            model = (payload.get("model") or os.getenv("LITELLM_MODEL") or "azure-gpt-5").strip()
            proxy = (payload.get("proxy") or "").strip()

            def _base(ready: bool, **extra) -> dict:
                """Shared base fields for all workflow action responses."""
                return {
                    "ok": True,
                    "action": action,
                    "ready": ready,
                    "validation": validation,
                    "normalized_input": normalized,
                    "effective_duration_seconds": normalized.get("duration", default_video_duration),
                    "input_diff": input_diff,
                    "input_fingerprint": input_fingerprint,
                    **extra,
                }

            if action == "validate":
                return jsonify(_base(validation["ok"]))

            if action == "generate_script":
                if not validation["ok"]:
                    return jsonify(_base(False))
                user_message = str(payload.get("user_message", "") or "")
                script = ""
                script_source = "template"
                llm_error = ""
                _ab_hash = hashlib.md5(api_base.encode()).hexdigest()[:6]
                _script_cache_key = f"script:{input_fingerprint}:{_ab_hash}:{model}:{hashlib.md5(user_message.encode()).hexdigest()[:8]}"
                _cached_script = _llm_response_cache.get(_script_cache_key)
                if _cached_script:
                    script = _cached_script["script"]
                    script_source = "llm_cached"
                elif api_key:
                    try:
                        status_code, data_wrap = _build_shoplive_script_via_llm(
                            normalized=normalized,
                            user_message=user_message,
                            api_base=api_base,
                            api_key=api_key,
                            model=model,
                            proxy=proxy,
                            build_shoplive_script_prompt=build_shoplive_script_prompt,
                            call_litellm_chat=call_litellm_chat,
                        )
                        if status_code < 400:
                            data = data_wrap.get("response", {})
                            script = extract_chat_content(data).strip()
                            if script:
                                script_source = "llm"
                                _llm_response_cache.set(_script_cache_key, {"script": script})
                            else:
                                llm_error = "LLM 未返回有效脚本内容"
                        else:
                            llm_error = f"LLM 脚本生成失败: {status_code}"
                    except Exception as e:
                        llm_error = str(e)
                if not script:
                    script = build_shoplive_script(normalized)
                check = selfcheck_script(script)
                return jsonify(_base(check["ok"],
                    script=script, script_source=script_source,
                    script_fallback_reason=llm_error, selfcheck=check,
                ))

            if action == "pre_export_check":
                script_text = str(payload.get("script_text", "") or "")
                check = selfcheck_script(script_text)
                ready = validation["ok"] and check["ok"]
                return jsonify(_base(ready, selfcheck=check))

            if action == "build_export_prompt":
                script_text = str(payload.get("script_text", "") or "")
                check = selfcheck_script(script_text)
                if not validation["ok"] or not check["ok"]:
                    return jsonify(
                        {
                            "ok": True,
                            "action": action,
                            "ready": False,
                            "validation": validation,
                            "selfcheck": check,
                            "normalized_input": normalized,
                            "effective_duration_seconds": normalized.get("duration", default_video_duration),
                            "input_diff": input_diff,
                            "input_fingerprint": input_fingerprint,
                        }
                    )
                prompt_text = ""
                prompt_source = "template_fallback"
                llm_error = ""
                _ab_hash = hashlib.md5(api_base.encode()).hexdigest()[:6]
                _prompt_cache_key = f"prompt:{input_fingerprint}:{_ab_hash}:{model}:{hashlib.md5(script_text.encode()).hexdigest()[:8]}"
                _cached_prompt = _llm_response_cache.get(_prompt_cache_key)
                if _cached_prompt:
                    prompt_text = _cached_prompt["prompt"]
                    prompt_source = "llm_cached"
                elif api_key:
                    try:
                        status_code, data_wrap = _build_shoplive_video_prompt_via_llm(
                            normalized=normalized,
                            script_text=script_text,
                            api_base=api_base,
                            api_key=api_key,
                            model=model,
                            proxy=proxy,
                            shoplive_video_system_prompt=shoplive_video_system_prompt,
                            call_litellm_chat=call_litellm_chat,
                        )
                        data = data_wrap.get("response", {})
                        if status_code < 400:
                            prompt_text = extract_chat_content(data).strip()
                            if prompt_text:
                                prompt_source = "llm"
                                _llm_response_cache.set(_prompt_cache_key, {"prompt": prompt_text})
                            else:
                                llm_error = "LLM 未返回可用视频提示词"
                        else:
                            llm_error = f"LLM 视频提示词生成失败: {status_code}"
                    except Exception as e:
                        llm_error = str(e)
                if not prompt_text:
                    prompt_text = build_shoplive_video_prompt_template(normalized, script_text)
                    prompt_source = "template_fallback"
                return jsonify(_base(bool(prompt_text),
                    status_code=200, selfcheck=check,
                    prompt=prompt_text, prompt_source=prompt_source,
                    prompt_fallback_reason=llm_error, response={},
                ))

            if action == "build_enhance_template":
                script_text = str(payload.get("script_text", "") or "")
                raw_prompt = str(payload.get("raw_prompt", "") or "")
                template_text = build_shoplive_agent_enhance_template(
                    normalized,
                    raw_prompt=raw_prompt,
                    script_text=script_text,
                )
                return jsonify(
                    {
                        "ok": True,
                        "status_code": 200,
                        "action": action,
                        "ready": bool(template_text),
                        "template": template_text,
                        "normalized_input": normalized,
                        "effective_duration_seconds": normalized.get("duration", default_video_duration),
                        "input_diff": input_diff,
                        "input_fingerprint": input_fingerprint,
                    }
                )

            return json_error(f"未知 action: {action}")
        except Exception as e:
            return json_error(f"Shoplive workflow 失败: {e}", 500)

