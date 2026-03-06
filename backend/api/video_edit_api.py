import base64
import os
import select
import signal
import subprocess
import tempfile
import threading
import time
import uuid
from pathlib import Path
from typing import Callable, Dict, Optional, Tuple

from flask import g, jsonify, request

from shoplive.backend.schemas import VideoEditExportRequest, VideoTimelineRenderRequest
from shoplive.backend.validation import validate_request


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


def _render_timeline_video(
    *,
    source_video_url: str,
    proxy: str,
    include_audio: bool,
    tracks,
    duration_hint,
    sort_strategy: str,
    output_video: Path,
    normalize_timeline_video_segments: Callable[..., list],
    download_video_to_file: Callable[[str, Path, str], None],
    on_progress: Optional[Callable[[int, str], None]] = None,
    should_cancel: Optional[Callable[[], bool]] = None,
    register_process_pid: Optional[Callable[[Optional[int]], None]] = None,
):
    with tempfile.TemporaryDirectory(prefix="shoplive-timeline-") as tmp_dir:
        tmp_dir_path = Path(tmp_dir)
        src_path = tmp_dir_path / "source.mp4"
        download_video_to_file(source_video_url, src_path, proxy)
        if on_progress:
            on_progress(30, "source_downloaded")
        if not src_path.exists() or src_path.stat().st_size < 1024:
            raise ValueError("源视频下载失败或内容为空")

        if duration_hint is None:
            probe = subprocess.run(
                [
                    "ffprobe",
                    "-v",
                    "error",
                    "-show_entries",
                    "format=duration",
                    "-of",
                    "default=noprint_wrappers=1:nokey=1",
                    str(src_path),
                ],
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
            )
            duration_str = (probe.stdout or "").strip()
            duration = float(duration_str) if duration_str else 0.0
        else:
            duration = float(duration_hint)
        if duration <= 0:
            raise ValueError("无法获取源视频时长，请提供 duration_seconds")

        normalized_segments = normalize_timeline_video_segments(
            tracks,
            duration,
            sort_strategy=sort_strategy,
        )
        if on_progress:
            on_progress(45, "segments_normalized")
        if not normalized_segments:
            raise ValueError("时间线中没有可渲染的视频片段")
        total_render_seconds = max(
            0.001,
            sum(max(0.0, float(seg["end"]) - float(seg["start"])) for seg in normalized_segments),
        )

        has_audio = False
        has_muted_video_track = any(
            isinstance(t, dict)
            and bool(t.get("enabled", True))
            and str(t.get("track_type") or "").strip().lower() in {"", "video"}
            and bool(t.get("muted", False))
            for t in tracks
        )
        effective_include_audio = include_audio and (not has_muted_video_track)
        if effective_include_audio:
            probe_audio = subprocess.run(
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
                    str(src_path),
                ],
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
            )
            has_audio = bool((probe_audio.stdout or "").strip())

        filter_parts = []
        for idx, seg in enumerate(normalized_segments):
            s = _fmt_float(seg["start"], 4)
            e = _fmt_float(seg["end"], 4)
            filter_parts.append(f"[0:v]trim=start={s}:end={e},setpts=PTS-STARTPTS[v{idx}]")
            if effective_include_audio and has_audio:
                filter_parts.append(f"[0:a]atrim=start={s}:end={e},asetpts=PTS-STARTPTS[a{idx}]")

        v_inputs = "".join([f"[v{i}]" for i in range(len(normalized_segments))])
        if effective_include_audio and has_audio:
            # concat(v=1,a=1) expects interleaved pads: [v0][a0][v1][a1]...
            va_inputs = "".join([f"[v{i}][a{i}]" for i in range(len(normalized_segments))])
            filter_parts.append(
                f"{va_inputs}concat=n={len(normalized_segments)}:v=1:a=1[vout][aout]"
            )
        else:
            filter_parts.append(f"{v_inputs}concat=n={len(normalized_segments)}:v=1:a=0[vout]")
        if on_progress:
            on_progress(60, "ffmpeg_started")

        cmd = [
            "ffmpeg",
            "-y",
            "-nostats",
            "-i",
            str(src_path),
            "-filter_complex",
            ";".join(filter_parts),
            "-map",
            "[vout]",
            "-progress",
            "pipe:1",
            "-c:v",
            "libx264",
            "-preset",
            "veryfast",
            "-crf",
            "20",
        ]
        if effective_include_audio and has_audio:
            cmd.extend(["-map", "[aout]", "-c:a", "aac"])
        else:
            cmd.append("-an")
        cmd.extend(["-movflags", "+faststart", str(output_video)])
        ffmpeg_proc = subprocess.Popen(
            cmd,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            bufsize=1,
        )
        if register_process_pid:
            register_process_pid(ffmpeg_proc.pid)
        try:
            deadline = time.time() + 300
            last_emit_progress = 60
            while ffmpeg_proc.poll() is None:
                if should_cancel and should_cancel():
                    ffmpeg_proc.terminate()
                    try:
                        ffmpeg_proc.wait(timeout=2)
                    except Exception:
                        ffmpeg_proc.kill()
                    raise RuntimeError("时间线渲染已取消")
                if time.time() > deadline:
                    ffmpeg_proc.terminate()
                    raise subprocess.TimeoutExpired(cmd, 300)
                if ffmpeg_proc.stdout:
                    ready, _, _ = select.select([ffmpeg_proc.stdout], [], [], 0.2)
                    if ready:
                        line = ffmpeg_proc.stdout.readline()
                        if line:
                            kv = line.strip().split("=", 1)
                            if len(kv) == 2 and kv[0] in {"out_time_ms", "out_time_us"}:
                                try:
                                    out_us = float(kv[1])
                                    if kv[0] == "out_time_ms":
                                        out_us *= 1000.0
                                    sec = max(0.0, out_us / 1_000_000.0)
                                    ratio = min(1.0, sec / total_render_seconds)
                                    progress = int(60 + ratio * 35)
                                    if on_progress and progress > last_emit_progress:
                                        on_progress(progress, "ffmpeg_progress")
                                        last_emit_progress = progress
                                except Exception:
                                    pass
                    else:
                        time.sleep(0.05)
                time.sleep(0.2)
            stdout, stderr = ffmpeg_proc.communicate()
        finally:
            if register_process_pid:
                register_process_pid(None)

        if ffmpeg_proc.returncode != 0 or (not output_video.exists()) or output_video.stat().st_size < 1024:
            msg = (stderr or stdout or "").strip()
            tail = msg[-600:] if len(msg) > 600 else msg
            raise RuntimeError(f"时间线渲染失败: {tail}")
        if on_progress:
            on_progress(90, "ffmpeg_done")

        return {
            "segments_rendered": len(normalized_segments),
            "timeline_duration_seconds": duration,
            "include_audio": effective_include_audio,
        }


def register_video_edit_routes(
    app,
    *,
    json_error: Callable[[str, int], Tuple],
    build_proxies: Callable[[str], Dict[str, str]],
    parse_generic_data_url: Callable[[str, str], Tuple[str, str]],
    escape_drawtext_text: Callable[[str], str],
    download_video_to_file: Callable[[str, Path, str], None],
    normalize_timeline_video_segments: Callable[..., list],
    concat_videos_ffmpeg: Callable[..., Path],
    video_edit_export_dir: Path,
):
    _ = concat_videos_ffmpeg
    timeline_jobs = {}
    timeline_jobs_lock = threading.Lock()

    def _update_job(job_id: str, **kwargs):
        with timeline_jobs_lock:
            job = timeline_jobs.get(job_id)
            if not job:
                return
            job.update(kwargs)
            job["updated_at"] = time.time()

    @app.post("/api/video/edit/export")
    @validate_request(VideoEditExportRequest)
    def api_video_edit_export():
        payload = g.req.model_dump()
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

    @app.post("/api/video/timeline/render")
    @validate_request(VideoTimelineRenderRequest)
    def api_video_timeline_render():
        payload = g.req.model_dump()
        try:
            source_video_url = str(payload.get("source_video_url") or "").strip()
            if not source_video_url:
                return json_error("source_video_url 不能为空")
            proxy = str(payload.get("proxy") or "").strip()
            include_audio = bool(payload.get("include_audio", True))
            tracks = payload.get("tracks") or []
            sort_strategy = str(payload.get("segment_sort_strategy") or "track_then_start").strip()
            async_job = bool(payload.get("async_job", False))

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

            output_name = f"timeline-render-{uuid.uuid4().hex}.mp4"
            output_video = video_edit_export_dir / output_name
            base = request.host_url.rstrip("/")

            if async_job:
                job_id = f"timeline-job-{uuid.uuid4().hex}"
                with timeline_jobs_lock:
                    timeline_jobs[job_id] = {
                        "job_id": job_id,
                        "status": "queued",
                        "progress": 0,
                        "message": "queued",
                        "created_at": time.time(),
                        "updated_at": time.time(),
                        "result": None,
                        "error": "",
                        "cancel_requested": False,
                        "process_pid": None,
                    }

                def _job_runner():
                    try:
                        _update_job(job_id, status="running", progress=15, message="rendering")
                        if timeline_jobs.get(job_id, {}).get("cancel_requested"):
                            _update_job(job_id, status="cancelled", progress=0, message="cancelled")
                            return
                        result = _render_timeline_video(
                            source_video_url=source_video_url,
                            proxy=proxy,
                            include_audio=include_audio,
                            tracks=tracks,
                            duration_hint=payload.get("duration_seconds"),
                            sort_strategy=sort_strategy,
                            output_video=output_video,
                            normalize_timeline_video_segments=normalize_timeline_video_segments,
                            download_video_to_file=download_video_to_file,
                            on_progress=lambda p, m: _update_job(job_id, progress=p, message=m),
                            should_cancel=lambda: bool(timeline_jobs.get(job_id, {}).get("cancel_requested")),
                            register_process_pid=lambda pid: _update_job(job_id, process_pid=pid),
                        )
                        if timeline_jobs.get(job_id, {}).get("cancel_requested"):
                            try:
                                output_video.unlink(missing_ok=True)
                            except Exception:
                                pass
                            _update_job(job_id, status="cancelled", progress=0, message="cancelled")
                            return
                        _update_job(
                            job_id,
                            status="done",
                            progress=100,
                            message="done",
                            result={
                                "ok": True,
                                "video_url": f"{base}/video-edits/{output_name}",
                                "file_name": output_name,
                                "segments_rendered": result["segments_rendered"],
                                "timeline_duration_seconds": result["timeline_duration_seconds"],
                                "include_audio": result["include_audio"],
                                "segment_sort_strategy": sort_strategy,
                            },
                        )
                    except Exception as e:
                        msg = str(e)
                        if "已取消" in msg or "cancel" in msg.lower():
                            _update_job(job_id, status="cancelled", progress=0, message="cancelled", error="")
                        else:
                            _update_job(job_id, status="failed", progress=100, message="failed", error=msg)

                threading.Thread(target=_job_runner, daemon=True).start()
                return jsonify({"ok": True, "async_job": True, "job_id": job_id, "status": "queued"})

            result = _render_timeline_video(
                source_video_url=source_video_url,
                proxy=proxy,
                include_audio=include_audio,
                tracks=tracks,
                duration_hint=payload.get("duration_seconds"),
                sort_strategy=sort_strategy,
                output_video=output_video,
                normalize_timeline_video_segments=normalize_timeline_video_segments,
                download_video_to_file=download_video_to_file,
            )

            return jsonify(
                {
                    "ok": True,
                    "video_url": f"{base}/video-edits/{output_name}",
                    "file_name": output_name,
                    "segments_rendered": result["segments_rendered"],
                    "timeline_duration_seconds": result["timeline_duration_seconds"],
                    "include_audio": result["include_audio"],
                    "segment_sort_strategy": sort_strategy,
                }
            )
        except ValueError as e:
            return json_error(str(e))
        except subprocess.TimeoutExpired:
            return json_error("时间线渲染超时，请缩短片段数量或时长", 500)
        except Exception as e:
            return json_error(f"时间线渲染失败: {e}", 500)

    @app.get("/api/video/timeline/render/status")
    def api_video_timeline_render_status():
        job_id = str(request.args.get("job_id") or "").strip()
        if not job_id:
            return json_error("job_id 不能为空")
        with timeline_jobs_lock:
            job = timeline_jobs.get(job_id)
            if not job:
                return json_error("job 不存在", 404)
            return jsonify(
                {
                    "ok": True,
                    "job_id": job_id,
                    "status": job.get("status"),
                    "progress": int(job.get("progress", 0)),
                    "message": job.get("message", ""),
                    "result": job.get("result"),
                    "error": job.get("error", ""),
                }
            )

    @app.post("/api/video/timeline/render/cancel")
    def api_video_timeline_render_cancel():
        payload = request.get_json(silent=True) or {}
        job_id = str(payload.get("job_id") or "").strip()
        if not job_id:
            return json_error("job_id 不能为空")
        with timeline_jobs_lock:
            job = timeline_jobs.get(job_id)
            if not job:
                return json_error("job 不存在", 404)
            if job.get("status") in {"done", "failed", "cancelled"}:
                return jsonify({"ok": True, "job_id": job_id, "status": job.get("status")})
            job["cancel_requested"] = True
            job["status"] = "cancelling"
            job["message"] = "cancelling"
            pid = job.get("process_pid")
            job["updated_at"] = time.time()
        if pid:
            try:
                os.kill(int(pid), signal.SIGTERM)
            except Exception:
                pass
        return jsonify({"ok": True, "job_id": job_id, "status": "cancelling"})
