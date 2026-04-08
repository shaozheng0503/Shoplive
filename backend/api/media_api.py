import logging
from typing import Any, Callable, Dict, List, Tuple

import requests
from flask import jsonify, request

from shoplive.backend.audit import AuditedOp

logger = logging.getLogger(__name__)


def register_media_routes(
    app,
    *,
    json_error: Callable[[str, int], Tuple],
    parse_common_payload: Callable[[Dict], Tuple[str, str, str, str]],
    get_access_token: Callable[[str, str], str],
    build_proxies: Callable[[str], Dict[str, str]],
    extract_banana_urls: Callable[[Dict], list],
    run_google_image_generate: Callable[[Dict], Tuple[int, Dict]],
    build_shoplive_image_prompt_compact: Callable[[Dict], str],
    build_shoplive_image_prompt_safe_product_only: Callable[[Dict], str],
    judge_generated_image_category: Callable[[Dict, Dict], Dict[str, Any]],
    build_image_prompt_via_llm: Callable[..., str] = None,
):
    @app.post("/api/gemini")
    def api_gemini():
        payload = request.get_json(silent=True) or {}
        op = AuditedOp("gemini_call", "generate_content", {
            "model": payload.get("model") or "gemini-3.1-pro-preview",
            "location": payload.get("location") or "global",
            "prompt_len": len(payload.get("prompt") or ""),
        })
        try:
            project_id, key_file, proxy, model = parse_common_payload(payload)
            prompt = (payload.get("prompt") or "").strip()
            location = (payload.get("location") or "global").strip()
            if not model:
                model = "gemini-3.1-pro-preview"
            if not prompt:
                return json_error("prompt 不能为空")

            token = get_access_token(key_file, proxy)
            url = (
                "https://aiplatform.googleapis.com/v1/projects/"
                f"{project_id}/locations/{location}/publishers/google/models/{model}:generateContent"
            )
            headers = {
                "Authorization": f"Bearer {token}",
                "Content-Type": "application/json; charset=utf-8",
            }
            body = {"contents": [{"role": "user", "parts": [{"text": prompt}]}]}
            resp = requests.post(
                url,
                headers=headers,
                json=body,
                timeout=90,
                proxies=build_proxies(proxy),
            )
            data = resp.json() if resp.headers.get("content-type", "").find("json") >= 0 else {"raw": resp.text}
            op.success({"status_code": resp.status_code, "ok": resp.ok})
            return jsonify(
                {
                    "ok": resp.ok,
                    "status_code": resp.status_code,
                    "model": model,
                    "response": data,
                }
            ), resp.status_code
        except ValueError as e:
            op.error(e, "value_error")
            return json_error(str(e))
        except Exception as e:
            op.error(e, "gemini_exception")
            return json_error(f"Gemini 调用失败: {e}", 500)

    @app.post("/api/banana/generate")
    def api_banana_generate():
        payload = request.get_json(silent=True) or {}
        op = AuditedOp("banana_generate", "generate_image", {
            "model": payload.get("model") or "gemini-2.5-flash-image",
            "image_size": payload.get("image_size") or "16:9",
            "num": int(payload.get("num", 1)),
            "prompt_len": len(payload.get("prompt") or ""),
        })
        try:
            api_base = (payload.get("api_base") or "https://api.nanobananaapi.dev").strip().rstrip("/")
            api_key = (payload.get("api_key") or "").strip()
            prompt = (payload.get("prompt") or "").strip()
            model = (payload.get("model") or "gemini-2.5-flash-image").strip()
            image_size = (payload.get("image_size") or "16:9").strip()
            num = int(payload.get("num", 1))
            proxy = (payload.get("proxy") or "").strip()
            if not api_key:
                return json_error("banana api_key 不能为空")
            if not prompt:
                return json_error("banana prompt 不能为空")
            url = f"{api_base}/v1/images/generate"
            headers = {
                "Authorization": f"Bearer {api_key}",
                "Content-Type": "application/json",
            }
            body = {"prompt": prompt, "model": model, "num": num, "image_size": image_size}
            resp = requests.post(
                url,
                headers=headers,
                json=body,
                timeout=90,
                proxies=build_proxies(proxy),
            )
            data = resp.json() if resp.headers.get("content-type", "").find("json") >= 0 else {"raw": resp.text}
            image_urls = extract_banana_urls(data)
            op.success({"status_code": resp.status_code, "ok": resp.ok, "image_count": len(image_urls)})
            return jsonify(
                {
                    "ok": resp.ok,
                    "status_code": resp.status_code,
                    "image_urls": image_urls,
                    "response": data,
                }
            ), resp.status_code
        except Exception as e:
            op.error(e, "banana_exception")
            return json_error(f"Banana 生图失败: {e}", 500)

    @app.post("/api/google-image/generate")
    def api_google_image_generate():
        payload = request.get_json(silent=True) or {}
        op = AuditedOp("google_image_generate", "generate_image", {
            "model": payload.get("model", "imagen-3.0-generate-002"),
            "sample_count": payload.get("sample_count", 1),
            "aspect_ratio": payload.get("aspect_ratio"),
            "prompt_len": len(payload.get("prompt") or ""),
        })
        try:
            status_code, data = run_google_image_generate(payload)
            op.success({"status_code": status_code, "ok": data.get("ok", False),
                        "images_count": len(data.get("images") or [])})
            return jsonify(data), status_code
        except ValueError as e:
            op.error(e, "value_error")
            return json_error(str(e))
        except Exception as e:
            op.error(e, "google_image_exception")
            return json_error(f"Google 生图失败: {e}", 500)

    @app.post("/api/shoplive/image/generate")
    def api_shoplive_image_generate():
        payload = request.get_json(silent=True) or {}
        op = AuditedOp("shoplive_image_generate", "generate_image", {
            "product_name": str(payload.get("product_name", ""))[:80],
            "model": payload.get("model", "imagen-3.0-generate-002"),
            "sample_count": int(payload.get("sample_count", 2)),
            "aspect_ratio": payload.get("aspect_ratio", "3:4"),
            "skip_category_check": bool(payload.get("skip_category_check", False)),
            "category_retry_max": int(payload.get("category_retry_max", 2)),
        })
        try:
            if not str(payload.get("product_name", "")).strip():
                return json_error("product_name 不能为空")
            skip_category_check = bool(payload.get("skip_category_check", False))
            max_retry_on_category_mismatch = int(payload.get("category_retry_max", 2))
            max_retry_on_category_mismatch = max(0, min(max_retry_on_category_mismatch, 4))

            image_payload = {
                "project_id": payload.get("project_id", "qy-shoplazza-02"),
                "proxy": payload.get("proxy", ""),
                "model": payload.get("model", "imagen-3.0-generate-002"),
                "sample_count": int(payload.get("sample_count", 2)),
                "aspect_ratio": payload.get("aspect_ratio", "3:4"),
                "location": payload.get("location", "us-central1"),
                "person_generation": payload.get("person_generation", "allow_adult"),
            }
            attempts: List[Dict[str, Any]] = []

            def attempt_generate(prompt_text: str, strategy: str, sample_count: int) -> Tuple[int, Dict, Dict[str, Any], bool]:
                req_payload = dict(image_payload)
                req_payload["prompt"] = prompt_text
                req_payload["sample_count"] = sample_count
                st, dt = run_google_image_generate(req_payload)
                judge = {"ok": False, "is_match": True, "reason": "skip_no_image"}
                mismatch = False
                images = dt.get("images") or []
                if st < 400 and images and not skip_category_check:
                    judge = judge_generated_image_category(payload, images[0])
                    mismatch = not bool(judge.get("is_match", True))
                attempts.append(
                    {
                        "strategy": strategy,
                        "status_code": st,
                        "ok": bool(dt.get("ok", False)),
                        "images_count": len(images),
                        "category_check": judge,
                    }
                )
                return st, dt, judge, mismatch

            prompt_primary = build_shoplive_image_prompt_compact(payload)

            # Optionally use LLM-driven prompt if configured and api_key present
            import os as _os
            _llm_api_base = (payload.get("api_base") or _os.getenv("LITELLM_API_BASE") or "").strip().rstrip("/")
            _llm_api_key  = (payload.get("api_key")  or _os.getenv("LITELLM_API_KEY")  or "").strip()
            _llm_model    = (payload.get("llm_model") or "bedrock-claude-4-5-haiku").strip()
            _use_llm_prompt = bool(build_image_prompt_via_llm and _llm_api_key)
            if _use_llm_prompt:
                try:
                    prompt_primary = build_image_prompt_via_llm(
                        payload,
                        api_base=_llm_api_base,
                        api_key=_llm_api_key,
                        model=_llm_model,
                        proxy=payload.get("proxy", ""),
                    )
                except Exception:
                    pass  # fall through to compact prompt on LLM failure

            st1, dt1, judge1, mismatch1 = attempt_generate(
                prompt_primary, "strict_compact_primary", int(payload.get("sample_count", 2))
            )
            if st1 < 400 and dt1.get("images") and not mismatch1:
                dt1["prompt_used"] = prompt_primary
                dt1["prompt_strategy"] = "llm_primary" if _use_llm_prompt else "strict_compact_primary"
                dt1["category_check"] = judge1
                dt1["attempts"] = attempts
                op.success({"strategy": dt1["prompt_strategy"], "attempts_count": len(attempts),
                            "images_count": len(dt1.get("images") or [])})
                return jsonify(dt1), st1

            prompt_safe = build_shoplive_image_prompt_safe_product_only(payload)
            st2, dt2, judge2, mismatch2 = attempt_generate(prompt_safe, "safe_product_only_retry", 1)
            if st2 < 400 and dt2.get("images") and not mismatch2:
                dt2["prompt_used"] = prompt_safe
                dt2["prompt_strategy"] = "safe_product_only_retry"
                dt2["category_check"] = judge2
                dt2["attempts"] = attempts
                op.success({"strategy": "safe_product_only_retry", "attempts_count": len(attempts),
                            "images_count": len(dt2.get("images") or [])})
                return jsonify(dt2), st2

            forced_prompt = (
                f"{prompt_safe} "
                "Hard category lock: the output must be exactly the expected product category only. "
                "If expected category is dress, show one complete full-length dress garment only."
            )
            retry_data = dt2
            retry_status = st2
            retry_judge = judge2
            for idx in range(max_retry_on_category_mismatch):
                s, d, j, mismatch = attempt_generate(
                    forced_prompt,
                    f"category_lock_retry_{idx + 1}",
                    1,
                )
                retry_data, retry_status, retry_judge = d, s, j
                if s < 400 and d.get("images") and not mismatch:
                    d["prompt_used"] = forced_prompt
                    d["prompt_strategy"] = f"category_lock_retry_{idx + 1}"
                    d["category_check"] = j
                    d["attempts"] = attempts
                    op.success({"strategy": f"category_lock_retry_{idx + 1}",
                                "attempts_count": len(attempts),
                                "images_count": len(d.get("images") or [])})
                    return jsonify(d), s

            op.error("category_mismatch_exhausted", "category_mismatch_exhausted")
            return (
                jsonify(
                    {
                        "ok": False,
                        "error": "实时生图未通过类目校验（已自动重试）。请调整商品名称或卖点后重试。",
                        "prompt_used": forced_prompt,
                        "prompt_strategy": "category_lock_retry_failed",
                        "category_check": retry_judge,
                        "attempts": attempts,
                        "last_attempt": {
                            "status_code": retry_status,
                            "ok": bool((retry_data or {}).get("ok", False)),
                            "response": (retry_data or {}).get("response", {}),
                        },
                    }
                ),
                502,
            )
        except ValueError as e:
            op.error(e, "value_error")
            return json_error(str(e))
        except Exception as e:
            op.error(e, "shoplive_image_exception")
            return json_error(f"Shoplive 生图失败: {e}", 500)

    @app.post("/api/pipeline/banana-to-veo")
    def api_pipeline_banana_to_veo():
        payload = request.get_json(silent=True) or {}
        op = AuditedOp("pipeline_banana_to_veo", "pipeline_complete", {
            "banana_model": payload.get("banana_model"),
            "veo_model": payload.get("veo_model"),
            "veo_mode": payload.get("veo_mode", "image"),
            "banana_prompt_len": len(payload.get("banana_prompt") or ""),
            "veo_prompt_len": len(payload.get("veo_prompt") or ""),
        })
        try:
            banana_proxy = (payload.get("proxy") or "").strip()
            banana_payload = {
                "api_base": payload.get("banana_api_base"),
                "api_key": payload.get("banana_api_key"),
                "prompt": payload.get("banana_prompt"),
                "model": payload.get("banana_model"),
                "image_size": payload.get("banana_image_size"),
                "num": payload.get("banana_num", 1),
                "proxy": banana_proxy,
            }
            with app.test_request_context(json=banana_payload):
                banana_resp = app.view_functions["api_banana_generate"]()
            banana_json, banana_status = banana_resp
            banana_data = banana_json.get_json(silent=True) or {}
            if banana_status >= 400 or not banana_data.get("image_urls"):
                op.error("banana_step_failed", "banana_step_failed")
                return jsonify(
                    {
                        "ok": False,
                        "step": "banana",
                        "banana": banana_data,
                        "error": "Banana 生图失败或无可用图片 URL",
                    }
                ), 400

            image_url = banana_data["image_urls"][0]
            veo_payload = {
                "project_id": payload.get("project_id"),
                "key_file": payload.get("key_file"),
                "proxy": payload.get("proxy"),
                "model": payload.get("veo_model"),
                "prompt": payload.get("veo_prompt"),
                "storage_uri": payload.get("storage_uri"),
                "sample_count": payload.get("sample_count", 1),
                "veo_mode": payload.get("veo_mode", "image"),
                "image_url": image_url,
                "reference_image_urls": payload.get("reference_image_urls", []),
                "reference_type": payload.get("reference_type", "asset"),
                "aspect_ratio": payload.get("aspect_ratio"),
                "resolution": payload.get("resolution"),
                "duration_seconds": payload.get("duration_seconds"),
                "negative_prompt": payload.get("negative_prompt"),
                "person_generation": payload.get("person_generation"),
                "resize_mode": payload.get("resize_mode"),
                "seed": payload.get("seed"),
            }
            with app.test_request_context(json=veo_payload):
                veo_resp = app.view_functions["api_veo_start"]()
            veo_json, veo_status = veo_resp
            veo_data = veo_json.get_json(silent=True) or {}
            if veo_status < 400:
                op.success({"veo_status": veo_status, "operation_name": veo_data.get("operation_name")})
            else:
                op.error("veo_step_failed", "veo_step_failed")
            return jsonify(
                {
                    "ok": veo_status < 400,
                    "step": "veo_start",
                    "banana": banana_data,
                    "veo": veo_data,
                    "image_url": image_url,
                    "operation_name": veo_data.get("operation_name"),
                }
            ), veo_status
        except Exception as e:
            op.error(e, "pipeline_exception")
            return json_error(f"Banana -> Veo 流程失败: {e}", 500)

    @app.post("/api/pipeline/google-image-to-veo")
    def api_pipeline_google_image_to_veo():
        payload = request.get_json(silent=True) or {}
        try:
            image_payload = {
                "project_id": payload.get("project_id"),
                "proxy": payload.get("proxy"),
                "prompt": payload.get("image_prompt"),
                "model": payload.get("image_model"),
                "location": payload.get("image_location"),
                "sample_count": payload.get("image_sample_count", 1),
                "aspect_ratio": payload.get("image_aspect_ratio", "16:9"),
                "person_generation": payload.get("image_person_generation", "allow_adult"),
            }
            image_status, image_data = run_google_image_generate(image_payload)
            if image_status >= 400 or not image_data.get("images"):
                return jsonify(
                    {
                        "ok": False,
                        "step": "google_image",
                        "google_image": image_data,
                        "error": "Google 生图失败或无图像输出",
                    }
                ), 400

            image_b64 = image_data["images"][0].get("base64", "")
            image_mime = image_data["images"][0].get("mime_type", "image/png")
            veo_payload = {
                "project_id": payload.get("project_id"),
                "proxy": payload.get("proxy"),
                "model": payload.get("veo_model"),
                "prompt": payload.get("veo_prompt"),
                "storage_uri": payload.get("storage_uri"),
                "sample_count": payload.get("sample_count", 1),
                "veo_mode": payload.get("veo_mode", "image"),
                "image_base64": image_b64,
                "image_mime_type": image_mime,
                "reference_image_urls": payload.get("reference_image_urls", []),
                "reference_type": payload.get("reference_type", "asset"),
                "aspect_ratio": payload.get("aspect_ratio"),
                "resolution": payload.get("resolution"),
                "duration_seconds": payload.get("duration_seconds"),
                "negative_prompt": payload.get("negative_prompt"),
                "person_generation": payload.get("person_generation"),
                "resize_mode": payload.get("resize_mode"),
                "seed": payload.get("seed"),
            }
            with app.test_request_context(json=veo_payload):
                veo_resp = app.view_functions["api_veo_start"]()
            veo_json, veo_status = veo_resp
            veo_data = veo_json.get_json(silent=True) or {}
            return jsonify(
                {
                    "ok": veo_status < 400,
                    "step": "veo_start",
                    "google_image": image_data,
                    "veo": veo_data,
                    "operation_name": veo_data.get("operation_name"),
                }
            ), veo_status
        except Exception as e:
            return json_error(f"Google 生图 -> Veo 流程失败: {e}", 500)
