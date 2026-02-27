import random
import time
import re
from typing import Callable, Dict, Tuple

import requests
from flask import Response, jsonify, request, stream_with_context
from google.cloud import storage
from google.oauth2 import service_account


def register_veo_routes(
    app,
    *,
    json_error: Callable[[str, int], Tuple],
    parse_common_payload: Callable[[Dict], Tuple[str, str, str, str]],
    get_access_token: Callable[[str, str], str],
    build_proxies: Callable[[str], Dict[str, str]],
    normalize_reference_urls: Callable[[object], list],
    normalize_reference_images_base64: Callable[[object], list],
    parse_data_url: Callable[[str], Tuple[str, str]],
    fetch_image_as_base64: Callable[[str, str], Tuple[str, str]],
    normalize_duration_seconds: Callable[[object], int],
    extract_gs_paths: Callable[[object], list],
    extract_inline_videos: Callable[[object], list],
    sign_gcs_url: Callable[[str, str], str],
):
    def _build_common_generation_parameters(payload: Dict, *, normalize_duration_seconds) -> Tuple[Dict, object, object]:
        sample_count = int(payload.get("sample_count", 1))
        parameters = {"sampleCount": sample_count}
        storage_uri = (payload.get("storage_uri") or "").strip()
        if storage_uri:
            if not storage_uri.startswith("gs://"):
                raise ValueError("storage_uri 必须是 gs:// 开头")
            parameters["storageUri"] = storage_uri
        raw_duration_seconds = payload.get("duration_seconds")
        effective_duration_seconds = None
        if raw_duration_seconds is not None and str(raw_duration_seconds).strip() != "":
            effective_duration_seconds = normalize_duration_seconds(raw_duration_seconds)
            parameters["durationSeconds"] = effective_duration_seconds
        for k, p_key in [
            ("aspectRatio", "aspect_ratio"),
            ("resolution", "resolution"),
            ("negativePrompt", "negative_prompt"),
            ("personGeneration", "person_generation"),
            ("resizeMode", "resize_mode"),
            ("seed", "seed"),
        ]:
            val = payload.get(p_key)
            if val is not None and str(val).strip() != "":
                parameters[k] = val
        return parameters, raw_duration_seconds, effective_duration_seconds

    def _extract_video_uris(operation_payload: Dict) -> list:
        gs_paths = extract_gs_paths(operation_payload)
        video_exts = (".mp4", ".mov", ".webm", ".m4v")
        return [x for x in gs_paths if x.lower().endswith(video_exts)]

    def _call_predict_long_running(*, project_id: str, model: str, token: str, proxy: str, body: Dict):
        url = (
            "https://us-central1-aiplatform.googleapis.com/v1/projects/"
            f"{project_id}/locations/us-central1/publishers/google/models/{model}:predictLongRunning"
        )
        headers = {
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json; charset=utf-8",
        }
        resp = requests.post(
            url,
            headers=headers,
            json=body,
            timeout=90,
            proxies=build_proxies(proxy),
        )
        data = resp.json() if resp.headers.get("content-type", "").find("json") >= 0 else {"raw": resp.text}
        return resp.status_code, resp.ok, data

    def _call_fetch_predict_operation(
        *,
        project_id: str,
        model: str,
        token: str,
        proxy: str,
        operation_name: str,
    ):
        url = (
            "https://us-central1-aiplatform.googleapis.com/v1/projects/"
            f"{project_id}/locations/us-central1/publishers/google/models/{model}:fetchPredictOperation"
        )
        headers = {
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json; charset=utf-8",
        }
        body = {"operationName": operation_name}
        resp = requests.post(
            url,
            headers=headers,
            json=body,
            timeout=90,
            proxies=build_proxies(proxy),
        )
        data = resp.json() if resp.headers.get("content-type", "").find("json") >= 0 else {"raw": resp.text}
        return resp.status_code, resp.ok, data

    def _poll_video_ready(
        *,
        project_id: str,
        model: str,
        token: str,
        proxy: str,
        operation_name: str,
        poll_interval_seconds: int = 6,
        max_wait_seconds: int = 720,
    ):
        started = time.time()
        last_data = {}
        while time.time() - started <= max_wait_seconds:
            _, _, op_data = _call_fetch_predict_operation(
                project_id=project_id,
                model=model,
                token=token,
                proxy=proxy,
                operation_name=operation_name,
            )
            last_data = op_data
            op_error = (
                op_data.get("error", {}).get("message")
                or op_data.get("response", {}).get("error", {}).get("message")
                or ""
            )
            video_uris = _extract_video_uris(op_data)
            if video_uris:
                return video_uris[0], op_data
            if op_data.get("done") and op_error:
                raise RuntimeError(op_error)
            time.sleep(max(1, poll_interval_seconds))
        raise TimeoutError(f"Veo operation 超时（>{max_wait_seconds}s）: {operation_name}")

    @app.post("/api/veo/start")
    def api_veo_start():
        payload = request.get_json(silent=True) or {}
        try:
            project_id, key_file, proxy, model = parse_common_payload(payload)
            prompt = (payload.get("prompt") or "").strip()
            storage_uri = (payload.get("storage_uri") or "").strip()
            sample_count = int(payload.get("sample_count", 1))
            veo_mode = (payload.get("veo_mode") or "text").strip()
            image_url = (payload.get("image_url") or "").strip()
            image_b64 = (payload.get("image_base64") or "").strip()
            image_mime_type = (payload.get("image_mime_type") or "image/png").strip()
            reference_urls = normalize_reference_urls(payload.get("reference_image_urls"))
            reference_images_base64 = normalize_reference_images_base64(
                payload.get("reference_images_base64")
            )
            reference_type = (payload.get("reference_type") or "asset").strip()
            if not model:
                model = "veo-3.1-generate-preview"
            if not prompt:
                return json_error("prompt 不能为空")
            if image_mime_type not in {"image/png", "image/jpeg"}:
                return json_error("image_mime_type 仅支持 image/png 或 image/jpeg")
            if image_b64.startswith("data:image/"):
                image_b64, image_mime_type = parse_data_url(image_b64)

            token = get_access_token(key_file, proxy)
            url = (
                "https://us-central1-aiplatform.googleapis.com/v1/projects/"
                f"{project_id}/locations/us-central1/publishers/google/models/{model}:predictLongRunning"
            )
            headers = {
                "Authorization": f"Bearer {token}",
                "Content-Type": "application/json; charset=utf-8",
            }
            instance = {"prompt": prompt}
            if veo_mode == "image":
                if not image_b64 and not image_url:
                    return json_error("veo_mode=image 时需提供 image_url 或 image_base64")
                if not image_b64 and image_url:
                    image_b64, image_mime_type = fetch_image_as_base64(image_url, proxy)
                instance["image"] = {
                    "bytesBase64Encoded": image_b64,
                    "mimeType": image_mime_type,
                }
            elif veo_mode == "reference":
                if not reference_urls and not reference_images_base64:
                    return json_error(
                        "veo_mode=reference 时 reference_image_urls 或 reference_images_base64 不能为空"
                    )
                refs = []
                for ref in reference_images_base64[:3]:
                    refs.append(
                        {
                            "image": {
                                "bytesBase64Encoded": ref["base64"],
                                "mimeType": ref["mime_type"],
                            },
                            "referenceType": reference_type,
                        }
                    )
                for ref_url in reference_urls[:3]:
                    ref_b64, ref_mime = fetch_image_as_base64(ref_url, proxy)
                    refs.append(
                        {
                            "image": {
                                "bytesBase64Encoded": ref_b64,
                                "mimeType": ref_mime,
                            },
                            "referenceType": reference_type,
                        }
                    )
                instance["referenceImages"] = refs
                if image_b64 or image_url:
                    if not image_b64 and image_url:
                        image_b64, image_mime_type = fetch_image_as_base64(image_url, proxy)
                    instance["image"] = {
                        "bytesBase64Encoded": image_b64,
                        "mimeType": image_mime_type,
                    }

            parameters, raw_duration_seconds, effective_duration_seconds = _build_common_generation_parameters(
                payload, normalize_duration_seconds=normalize_duration_seconds
            )

            body = {"instances": [instance], "parameters": parameters}
            resp = requests.post(
                url,
                headers=headers,
                json=body,
                timeout=90,
                proxies=build_proxies(proxy),
            )
            data = resp.json() if resp.headers.get("content-type", "").find("json") >= 0 else {"raw": resp.text}
            return jsonify(
                {
                    "ok": resp.ok,
                    "status_code": resp.status_code,
                    "model": model,
                    "veo_mode": veo_mode,
                    "operation_name": data.get("name"),
                    "requested_duration_seconds": raw_duration_seconds,
                    "effective_duration_seconds": effective_duration_seconds,
                    "response": data,
                }
            ), resp.status_code
        except ValueError as e:
            return json_error(str(e))
        except Exception as e:
            return json_error(f"Veo 提交失败: {e}", 500)

    @app.post("/api/veo/extend")
    def api_veo_extend():
        payload = request.get_json(silent=True) or {}
        try:
            project_id, key_file, proxy, model = parse_common_payload(payload)
            prompt = (payload.get("prompt") or "").strip()
            source_video_gcs_uri = (
                payload.get("source_video_gcs_uri")
                or payload.get("video_gcs_uri")
                or payload.get("input_video_gcs_uri")
                or ""
            ).strip()
            if not model:
                model = "veo-3.1-generate-preview"
            if not prompt:
                return json_error("prompt 不能为空")
            if not source_video_gcs_uri:
                return json_error("source_video_gcs_uri 不能为空（需传入待延展的视频 gs:// 路径）")
            if not source_video_gcs_uri.startswith("gs://"):
                return json_error("source_video_gcs_uri 必须是 gs:// 开头")
            if not source_video_gcs_uri.lower().endswith(".mp4"):
                return json_error("source_video_gcs_uri 目前仅支持 mp4 文件")

            token = get_access_token(key_file, proxy)
            url = (
                "https://us-central1-aiplatform.googleapis.com/v1/projects/"
                f"{project_id}/locations/us-central1/publishers/google/models/{model}:predictLongRunning"
            )
            headers = {
                "Authorization": f"Bearer {token}",
                "Content-Type": "application/json; charset=utf-8",
            }
            instance = {
                "prompt": prompt,
                "video": {
                    "gcsUri": source_video_gcs_uri,
                    "mimeType": "video/mp4",
                },
            }
            parameters, raw_duration_seconds, effective_duration_seconds = _build_common_generation_parameters(
                payload, normalize_duration_seconds=normalize_duration_seconds
            )
            body = {"instances": [instance], "parameters": parameters}
            resp = requests.post(
                url,
                headers=headers,
                json=body,
                timeout=90,
                proxies=build_proxies(proxy),
            )
            data = resp.json() if resp.headers.get("content-type", "").find("json") >= 0 else {"raw": resp.text}
            return jsonify(
                {
                    "ok": resp.ok,
                    "status_code": resp.status_code,
                    "model": model,
                    "mode": "extend",
                    "source_video_gcs_uri": source_video_gcs_uri,
                    "operation_name": data.get("name"),
                    "requested_duration_seconds": raw_duration_seconds,
                    "effective_duration_seconds": effective_duration_seconds,
                    "target_total_seconds": payload.get("target_total_seconds", 16),
                    "response": data,
                }
            ), resp.status_code
        except ValueError as e:
            return json_error(str(e))
        except Exception as e:
            return json_error(f"Veo Extend 提交失败: {e}", 500)

    @app.post("/api/veo/chain")
    def api_veo_chain():
        payload = request.get_json(silent=True) or {}
        try:
            project_id, key_file, proxy, model = parse_common_payload(payload)
            prompt = (payload.get("prompt") or "").strip()
            if not model:
                model = "veo-3.1-generate-preview"
            if not prompt:
                return json_error("prompt 不能为空")
            storage_uri = (payload.get("storage_uri") or "").strip()
            if not storage_uri:
                return json_error("veo 链式生成必须提供 storage_uri（gs://）")
            if not storage_uri.startswith("gs://"):
                return json_error("storage_uri 必须是 gs:// 开头")

            try:
                target_total_seconds = int(payload.get("target_total_seconds") or payload.get("duration_seconds") or 8)
            except Exception:
                target_total_seconds = 8
            if target_total_seconds not in {8, 16, 24}:
                return json_error("target_total_seconds 仅支持 8/16/24")
            extend_rounds = max(0, target_total_seconds // 8 - 1)

            sample_count = int(payload.get("sample_count", 1))
            if sample_count < 1 or sample_count > 4:
                return json_error("sample_count 仅支持 1-4")

            poll_interval_seconds = int(payload.get("poll_interval_seconds", 6))
            max_wait_seconds = int(payload.get("max_wait_seconds", 720))
            extend_retry_max = int(payload.get("extend_retry_max", 1))
            extend_retry_max = max(0, min(extend_retry_max, 2))
            extend_retry_delay_seconds = int(payload.get("extend_retry_delay_seconds", 2))
            extend_retry_delay_seconds = max(0, min(extend_retry_delay_seconds, 10))

            seeded_payload = dict(payload)
            if seeded_payload.get("seed") is None or str(seeded_payload.get("seed")).strip() == "":
                seeded_payload["seed"] = random.randint(1, 4294967295)

            token = get_access_token(key_file, proxy)
            segments = []

            # Step 1: base 8s generation (supports text/image/reference modes)
            base_payload = dict(seeded_payload)
            base_payload["duration_seconds"] = 8
            veo_mode = (base_payload.get("veo_mode") or "text").strip()
            image_url = (base_payload.get("image_url") or "").strip()
            image_b64 = (base_payload.get("image_base64") or "").strip()
            image_mime_type = (base_payload.get("image_mime_type") or "image/png").strip()
            reference_urls = normalize_reference_urls(base_payload.get("reference_image_urls"))
            reference_images_base64 = normalize_reference_images_base64(base_payload.get("reference_images_base64"))
            reference_type = (base_payload.get("reference_type") or "asset").strip()
            if image_b64.startswith("data:image/"):
                image_b64, image_mime_type = parse_data_url(image_b64)
            if image_mime_type not in {"image/png", "image/jpeg"}:
                return json_error("image_mime_type 仅支持 image/png 或 image/jpeg")

            base_instance = {"prompt": prompt}
            if veo_mode == "image":
                if not image_b64 and not image_url:
                    return json_error("veo_mode=image 时需提供 image_url 或 image_base64")
                if not image_b64 and image_url:
                    image_b64, image_mime_type = fetch_image_as_base64(image_url, proxy)
                base_instance["image"] = {
                    "bytesBase64Encoded": image_b64,
                    "mimeType": image_mime_type,
                }
            elif veo_mode == "reference":
                if not reference_urls and not reference_images_base64:
                    return json_error("veo_mode=reference 时 reference_image_urls 或 reference_images_base64 不能为空")
                refs = []
                for ref in reference_images_base64[:3]:
                    refs.append(
                        {
                            "image": {
                                "bytesBase64Encoded": ref["base64"],
                                "mimeType": ref["mime_type"],
                            },
                            "referenceType": reference_type,
                        }
                    )
                for ref_url in reference_urls[:3]:
                    ref_b64, ref_mime = fetch_image_as_base64(ref_url, proxy)
                    refs.append(
                        {
                            "image": {
                                "bytesBase64Encoded": ref_b64,
                                "mimeType": ref_mime,
                            },
                            "referenceType": reference_type,
                        }
                    )
                base_instance["referenceImages"] = refs
                if image_b64 or image_url:
                    if not image_b64 and image_url:
                        image_b64, image_mime_type = fetch_image_as_base64(image_url, proxy)
                    base_instance["image"] = {
                        "bytesBase64Encoded": image_b64,
                        "mimeType": image_mime_type,
                    }

            base_parameters, _, base_effective_duration = _build_common_generation_parameters(
                base_payload, normalize_duration_seconds=normalize_duration_seconds
            )
            status_code, ok, submit_data = _call_predict_long_running(
                project_id=project_id,
                model=model,
                token=token,
                proxy=proxy,
                body={"instances": [base_instance], "parameters": base_parameters},
            )
            if not ok:
                return (
                    jsonify(
                        {
                            "ok": False,
                            "status_code": status_code,
                            "step": "base_generate",
                            "response": submit_data,
                        }
                    ),
                    status_code,
                )
            base_operation_name = submit_data.get("name")
            if not base_operation_name:
                return json_error("Veo base operation_name 缺失", 502)
            base_video_uri, _ = _poll_video_ready(
                project_id=project_id,
                model=model,
                token=token,
                proxy=proxy,
                operation_name=base_operation_name,
                poll_interval_seconds=poll_interval_seconds,
                max_wait_seconds=max_wait_seconds,
            )
            try:
                base_signed_url = sign_gcs_url(base_video_uri, key_file)
            except Exception:
                base_signed_url = ""
            segments.append(
                {
                    "step": 1,
                    "type": "base_generate",
                    "operation_name": base_operation_name,
                    "effective_duration_seconds": base_effective_duration,
                    "video_gcs_uri": base_video_uri,
                    "signed_video_url": base_signed_url,
                }
            )

            # Step 2+: chained extends for 16/24
            current_video_uri = base_video_uri
            for idx in range(extend_rounds):
                source_video_uri = current_video_uri
                extend_prompt = (
                    (seeded_payload.get("extend_prompt") or "").strip()
                    or (
                        f"{prompt} Continue seamlessly from previous segment. "
                        "Keep the same product identity, camera language, lighting, color palette, and motion style. "
                        "No abrupt scene jump."
                    )
                )
                extend_instance = {
                    "prompt": extend_prompt,
                    "video": {
                        "gcsUri": current_video_uri,
                        "mimeType": "video/mp4",
                    },
                }
                extend_payload = dict(seeded_payload)
                extend_payload.pop("duration_seconds", None)
                extend_parameters, _, _ = _build_common_generation_parameters(
                    extend_payload, normalize_duration_seconds=normalize_duration_seconds
                )
                extend_operation_name = ""
                attempt_count = 0
                retry_errors = []
                last_submit_data = {}
                for attempt in range(extend_retry_max + 1):
                    attempt_count = attempt + 1
                    st2, ok2, extend_submit_data = _call_predict_long_running(
                        project_id=project_id,
                        model=model,
                        token=token,
                        proxy=proxy,
                        body={"instances": [extend_instance], "parameters": extend_parameters},
                    )
                    last_submit_data = extend_submit_data
                    if not ok2:
                        retry_errors.append(f"attempt_{attempt_count}: submit_failed status={st2}")
                        if attempt < extend_retry_max:
                            time.sleep(extend_retry_delay_seconds)
                        continue
                    extend_operation_name = str(extend_submit_data.get("name") or "").strip()
                    if not extend_operation_name:
                        retry_errors.append(f"attempt_{attempt_count}: operation_name_missing")
                        if attempt < extend_retry_max:
                            time.sleep(extend_retry_delay_seconds)
                        continue
                    try:
                        current_video_uri, _ = _poll_video_ready(
                            project_id=project_id,
                            model=model,
                            token=token,
                            proxy=proxy,
                            operation_name=extend_operation_name,
                            poll_interval_seconds=poll_interval_seconds,
                            max_wait_seconds=max_wait_seconds,
                        )
                        break
                    except Exception as poll_err:
                        retry_errors.append(f"attempt_{attempt_count}: {poll_err}")
                        if attempt < extend_retry_max:
                            time.sleep(extend_retry_delay_seconds)
                else:
                    return (
                        jsonify(
                            {
                                "ok": False,
                                "status_code": 502,
                                "step": f"extend_{idx + 1}",
                                "segments": segments,
                                "retry_errors": retry_errors,
                                "response": last_submit_data,
                            }
                        ),
                        502,
                    )
                try:
                    extend_signed_url = sign_gcs_url(current_video_uri, key_file)
                except Exception:
                    extend_signed_url = ""
                segments.append(
                    {
                        "step": idx + 2,
                        "type": "extend",
                        "operation_name": extend_operation_name,
                        "source_video_gcs_uri": source_video_uri,
                        "video_gcs_uri": current_video_uri,
                        "signed_video_url": extend_signed_url,
                        "attempt_count": attempt_count,
                    }
                )

            return jsonify(
                {
                    "ok": True,
                    "status_code": 200,
                    "model": model,
                    "mode": "chain_extend",
                    "seed": seeded_payload.get("seed"),
                    "target_total_seconds": target_total_seconds,
                    "segment_count": len(segments),
                    "segments": segments,
                    "final_video_gcs_uri": current_video_uri,
                    "final_signed_video_url": segments[-1].get("signed_video_url") if segments else "",
                    "consistency_strategy": {
                        "reuse_seed": True,
                        "reuse_parameters": ["aspect_ratio", "resolution", "negative_prompt", "person_generation", "seed"],
                        "extend_prompt_anchor": True,
                        "extend_retry_max": extend_retry_max,
                    },
                }
            )
        except ValueError as e:
            return json_error(str(e))
        except Exception as e:
            return json_error(f"Veo 链式生成失败: {e}", 500)

    @app.post("/api/veo/status")
    def api_veo_status():
        payload = request.get_json(silent=True) or {}
        try:
            project_id, key_file, proxy, model = parse_common_payload(payload)
            operation_name = (payload.get("operation_name") or "").strip()
            if not model:
                model = "veo-3.1-generate-preview"
            if not operation_name:
                return json_error("operation_name 不能为空")

            token = get_access_token(key_file, proxy)
            url = (
                "https://us-central1-aiplatform.googleapis.com/v1/projects/"
                f"{project_id}/locations/us-central1/publishers/google/models/{model}:fetchPredictOperation"
            )
            headers = {
                "Authorization": f"Bearer {token}",
                "Content-Type": "application/json; charset=utf-8",
            }
            body = {"operationName": operation_name}
            resp = requests.post(
                url,
                headers=headers,
                json=body,
                timeout=90,
                proxies=build_proxies(proxy),
            )
            data = resp.json() if resp.headers.get("content-type", "").find("json") >= 0 else {"raw": resp.text}
            gs_paths = extract_gs_paths(data)
            video_exts = (".mp4", ".mov", ".webm", ".m4v")
            video_uris = [x for x in gs_paths if x.lower().endswith(video_exts)]
            inline_videos = extract_inline_videos(data)
            signed_video_urls = []
            signed_all_urls = []
            for uri in gs_paths:
                try:
                    signed_all_urls.append({"gs_uri": uri, "url": sign_gcs_url(uri, key_file)})
                except Exception:
                    pass
            for uri in video_uris:
                try:
                    signed_video_urls.append({"gs_uri": uri, "url": sign_gcs_url(uri, key_file)})
                except Exception:
                    pass
            return jsonify(
                {
                    "ok": resp.ok,
                    "status_code": resp.status_code,
                    "model": model,
                    "video_uris": video_uris,
                    "signed_all_urls": signed_all_urls,
                    "signed_video_urls": signed_video_urls,
                    "inline_videos": inline_videos,
                    "response": data,
                }
            ), resp.status_code
        except ValueError as e:
            return json_error(str(e))
        except Exception as e:
            return json_error(f"Veo 状态查询失败: {e}", 500)

    @app.route("/api/veo/play", methods=["GET", "HEAD"])
    def api_veo_play():
        try:
            gcs_uri = str(request.args.get("gcs_uri") or "").strip()
            if not gcs_uri:
                return json_error("gcs_uri 不能为空")
            if not gcs_uri.startswith("gs://"):
                return json_error("gcs_uri 必须是 gs:// 开头")
            key_hint = str(request.args.get("key_file") or "").strip()
            payload = {
                "project_id": "gemini-sl-20251120",
                "key_file": key_hint,
                "proxy": "",
                "model": "",
            }
            project_id, key_file, _, _ = parse_common_payload(payload)
            m = re.match(r"^gs:\/\/([^\/]+)\/(.+)$", gcs_uri)
            if not m:
                return json_error("gcs_uri 格式错误")
            bucket_name, blob_name = m.group(1), m.group(2)
            creds = service_account.Credentials.from_service_account_file(
                key_file, scopes=["https://www.googleapis.com/auth/cloud-platform"]
            )
            client = storage.Client(project=project_id, credentials=creds)
            blob = client.bucket(bucket_name).blob(blob_name)
            blob.reload()
            total_size = int(blob.size or 0)
            content_type = str(blob.content_type or "video/mp4")
            base_headers = {"Accept-Ranges": "bytes", "Content-Type": content_type}

            if request.method.upper() == "HEAD":
                if total_size > 0:
                    base_headers["Content-Length"] = str(total_size)
                return Response(status=200, headers=base_headers)

            range_header = str(request.headers.get("Range") or "").strip()
            if not range_header:
                data = blob.download_as_bytes()
                headers = dict(base_headers)
                headers["Content-Length"] = str(len(data))
                return Response(data, status=200, headers=headers)

            m_range = re.match(r"^bytes=(\d*)-(\d*)$", range_header)
            if not m_range:
                return Response(status=416, headers=base_headers)
            start_raw, end_raw = m_range.group(1), m_range.group(2)
            if start_raw == "" and end_raw == "":
                return Response(status=416, headers=base_headers)

            if start_raw == "":
                # suffix bytes: bytes=-N
                suffix = int(end_raw)
                if total_size <= 0 or suffix <= 0:
                    return Response(status=416, headers=base_headers)
                start = max(0, total_size - suffix)
                end = total_size - 1
            else:
                start = int(start_raw)
                end = int(end_raw) if end_raw != "" else max(0, total_size - 1)

            if total_size > 0:
                end = min(end, total_size - 1)
            if start < 0 or end < start:
                return Response(status=416, headers=base_headers)

            data = blob.download_as_bytes(start=start, end=end)
            headers = dict(base_headers)
            headers["Content-Length"] = str(len(data))
            if total_size > 0:
                headers["Content-Range"] = f"bytes {start}-{end}/{total_size}"
            return Response(data, status=206, headers=headers)
        except ValueError as e:
            return json_error(str(e))
        except Exception as e:
            return json_error(f"Veo 播放地址生成失败: {e}", 500)

