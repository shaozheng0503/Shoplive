from typing import Callable, Dict, Tuple

import requests
from flask import jsonify, request


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
            if storage_uri and not storage_uri.startswith("gs://"):
                return json_error("storage_uri 必须是 gs:// 开头")
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

            parameters = {"sampleCount": sample_count}
            if storage_uri:
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

