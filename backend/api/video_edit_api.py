import base64
import subprocess
import tempfile
import uuid
from pathlib import Path
from typing import Callable, Dict, Tuple

from flask import jsonify, request


def _clamp_num(value, minimum, maximum, default):
    try:
        num = float(value)
    except (TypeError, ValueError):
        num = float(default)
    return max(minimum, min(maximum, num))


def _fmt_float(value: float, digits: int = 4) -> str:
    return f"{float(value):.{digits}f}".rstrip("0").rstrip(".")


def _build_atempo_chain(speed: float) -> str:
    target = max(0.5, min(2.0, speed))
    chunks = []
    while target > 2.0:
        chunks.append("2.0")
        target /= 2.0
    while target < 0.5:
        chunks.append("0.5")
        target *= 2.0
    chunks.append(_fmt_float(target, 3))
    return ",".join([f"atempo={x}" for x in chunks])


def register_video_edit_routes(
    app,
    *,
    json_error: Callable[[str, int], Tuple],
    build_proxies: Callable[[str], Dict[str, str]],
    parse_generic_data_url: Callable[[str, str], Tuple[str, str]],
    escape_drawtext_text: Callable[[str], str],
    download_video_to_file: Callable[[str, Path, str], None],
    video_edit_export_dir: Path,
):
    @app.post("/api/video/edit/export")
    def api_video_edit_export():
        payload = request.get_json(silent=True) or {}
        try:
            video_url = str(payload.get("video_url") or "").strip()
            if not video_url:
                return json_error("video_url 不能为空")

            proxy = str(payload.get("proxy") or "").strip()
            edits = payload.get("edits") or {}
            if not isinstance(edits, dict):
                edits = {}

            try:
                subprocess.run(
                    ["ffmpeg", "-version"],
                    check=True,
                    stdout=subprocess.PIPE,
                    stderr=subprocess.PIPE,
                    text=True,
                )
            except Exception:
                return json_error("未检测到 ffmpeg，请先安装 ffmpeg", 500)
            drawtext_check = subprocess.run(
                ["ffmpeg", "-hide_banner", "-filters"],
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
            )
            drawtext_available = "drawtext" in ((drawtext_check.stdout or "") + (drawtext_check.stderr or ""))

            speed = _clamp_num(edits.get("speed", 1), 0.5, 2.0, 1.0)
            sat_val = _clamp_num(edits.get("sat", 0), -30, 30, 0)
            vibrance_val = _clamp_num(edits.get("vibrance", 0), -30, 30, 0)
            temp_val = _clamp_num(edits.get("temp", 0), -30, 30, 0)
            tint_val = _clamp_num(edits.get("tint", 0), -30, 30, 0)
            mask_text = str(edits.get("maskText") or "").strip()
            mask_opacity = _clamp_num(edits.get("opacity", 90), 0, 100, 90) / 100.0
            x_pct = _clamp_num(edits.get("x", 50), 0, 100, 50)
            y_pct = _clamp_num(edits.get("y", 88), 0, 100, 88)
            h_pct = _clamp_num(edits.get("h", 14), 6, 60, 14)
            bgm_extract = bool(edits.get("bgmExtract"))
            bgm_volume = _clamp_num(edits.get("bgmVolume", 70), 0, 100, 70) / 100.0
            local_bgm_data_url = str(edits.get("localBgmDataUrl") or "").strip()

            sat = _clamp_num((100 + sat_val * 3) / 100.0, 0.2, 2.6, 1.0)
            bright = _clamp_num((100 + vibrance_val * 2 - 100) / 100.0, -0.6, 1.2, 0.0)
            contrast = _clamp_num((100 + abs(temp_val) * 1.2) / 100.0, 0.6, 1.8, 1.0)
            hue = _clamp_num(tint_val * 1.8, -45, 45, 0)
            text_size = int(max(18, min(72, h_pct * 3.2)))
            text_y_expr = f"(H*{_fmt_float(y_pct / 100)}-text_h/2)"
            text_x_expr = f"(W*{_fmt_float(x_pct / 100)}-text_w/2)"

            with tempfile.TemporaryDirectory(prefix="shoplive-edit-") as tmp_dir:
                tmp_dir_path = Path(tmp_dir)
                input_video = tmp_dir_path / "input.mp4"
                output_name = f"video-edit-{uuid.uuid4().hex}.mp4"
                output_video = video_edit_export_dir / output_name
                bgm_file = None

                download_video_to_file(video_url, input_video, proxy)
                if not input_video.exists() or input_video.stat().st_size == 0:
                    return json_error("原始视频下载失败或内容为空", 400)

                if bgm_extract and local_bgm_data_url:
                    bgm_b64, bgm_mime = parse_generic_data_url(local_bgm_data_url, "audio")
                    suffix = ".mp3"
                    if "wav" in bgm_mime:
                        suffix = ".wav"
                    elif "ogg" in bgm_mime:
                        suffix = ".ogg"
                    elif "m4a" in bgm_mime or "aac" in bgm_mime:
                        suffix = ".m4a"
                    bgm_file = tmp_dir_path / f"bgm{suffix}"
                    bgm_file.write_bytes(base64.b64decode(bgm_b64))

                video_filters = [
                    f"setpts={_fmt_float(1.0 / speed, 4)}*PTS",
                    f"eq=saturation={_fmt_float(sat)}:brightness={_fmt_float(bright)}:contrast={_fmt_float(contrast)}",
                    f"hue=h={_fmt_float(hue, 3)}",
                ]
                mask_applied = False
                if mask_text and drawtext_available:
                    safe_text = escape_drawtext_text(mask_text)
                    video_filters.append(
                        "drawtext="
                        f"text='{safe_text}':"
                        f"fontsize={text_size}:"
                        "fontcolor=white:"
                        f"alpha={_fmt_float(mask_opacity, 3)}:"
                        f"x={text_x_expr}:"
                        f"y={text_y_expr}:"
                        "box=1:"
                        "boxcolor=black@0.28:"
                        "boxborderw=14"
                    )
                    mask_applied = True

                cmd = [
                    "ffmpeg",
                    "-y",
                    "-i",
                    str(input_video),
                ]
                use_bgm = bool(bgm_file and bgm_file.exists())
                if use_bgm:
                    cmd.extend(["-i", str(bgm_file)])

                probe = subprocess.run(
                    [
                        "ffprobe",
                        "-v",
                        "error",
                        "-select_streams",
                        "a",
                        "-show_entries",
                        "stream=index",
                        "-of",
                        "csv=p=0",
                        str(input_video),
                    ],
                    stdout=subprocess.PIPE,
                    stderr=subprocess.PIPE,
                    text=True,
                )
                has_input_audio = bool((probe.stdout or "").strip())

                filter_parts = []
                if video_filters:
                    filter_parts.append("[0:v]" + ",".join(video_filters) + "[vout]")

                atempo = _build_atempo_chain(speed)
                if use_bgm and has_input_audio:
                    filter_parts.append(f"[0:a]{atempo}[a0]")
                    filter_parts.append(f"[1:a]volume={_fmt_float(bgm_volume, 3)},{atempo}[a1]")
                    filter_parts.append("[a0][a1]amix=inputs=2:duration=first:dropout_transition=2[aout]")
                elif use_bgm and not has_input_audio:
                    filter_parts.append(f"[1:a]volume={_fmt_float(bgm_volume, 3)},{atempo}[aout]")
                elif has_input_audio:
                    filter_parts.append(f"[0:a]{atempo}[aout]")

                cmd.extend(["-filter_complex", ";".join(filter_parts), "-map", "[vout]"])
                if use_bgm or has_input_audio:
                    cmd.extend(["-map", "[aout]", "-c:a", "aac"])
                else:
                    cmd.extend(
                        [
                            "-an",
                        ]
                    )
                cmd.extend(
                    [
                        "-c:v",
                        "libx264",
                        "-preset",
                        "veryfast",
                        "-crf",
                        "20",
                        "-movflags",
                        "+faststart",
                        str(output_video),
                    ]
                )

                proc = subprocess.run(
                    cmd,
                    stdout=subprocess.PIPE,
                    stderr=subprocess.PIPE,
                    text=True,
                    timeout=300,
                )
                if proc.returncode != 0 or not output_video.exists():
                    msg = (proc.stderr or proc.stdout or "").strip()
                    tail = msg[-600:] if len(msg) > 600 else msg
                    return json_error(f"ffmpeg 导出失败: {tail}", 500)

            base = request.host_url.rstrip("/")
            warning = ""
            if mask_text and not mask_applied:
                warning = "当前 ffmpeg 不支持 drawtext，文字蒙版未写入导出视频"
            return jsonify(
                {
                    "ok": True,
                    "video_url": f"{base}/video-edits/{output_name}",
                    "file_name": output_name,
                    "mask_applied": mask_applied,
                    "warning": warning,
                }
            )
        except ValueError as e:
            return json_error(str(e))
        except subprocess.TimeoutExpired:
            return json_error("视频导出超时，请缩短视频时长或减少编辑项", 500)
        except Exception as e:
            return json_error(f"视频导出失败: {e}", 500)
