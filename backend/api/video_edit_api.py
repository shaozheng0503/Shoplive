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
from typing import Callable, Dict, List, Optional, Tuple

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


def _probe_has_audio(src_path: Path) -> bool:
    """Return True if the video file has at least one audio stream."""
    result = subprocess.run(
        [
            "ffprobe", "-v", "error",
            "-select_streams", "a",
            "-show_entries", "stream=index",
            "-of", "csv=p=0",
            str(src_path),
        ],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )
    return bool((result.stdout or "").strip())


def _normalize_track_ranges(points, duration_seconds: float) -> List[Tuple[float, float]]:
    vals = []
    for item in (points or []):
        try:
            v = float(item)
        except (TypeError, ValueError):
            continue
        if v < 0:
            continue
        vals.append(v)
    vals.sort()
    ranges: List[Tuple[float, float]] = []
    max_dur = max(0.001, float(duration_seconds or 0.0))
    for i in range(0, len(vals) - 1, 2):
        start = max(0.0, min(vals[i], max_dur))
        end = max(0.0, min(vals[i + 1], max_dur))
        if end > start:
            ranges.append((start, end))
    return ranges


def _build_time_enable_expr(ranges: List[Tuple[float, float]]) -> str:
    if not ranges:
        return ""
    parts = [f"between(t,{_fmt_float(s, 3)},{_fmt_float(e, 3)})" for s, e in ranges]
    return "+".join(parts)


def _resolve_track_mode(edits: Dict, track_id: str, duration_seconds: float) -> Tuple[str, List[Tuple[float, float]]]:
    timeline = edits.get("timeline") if isinstance(edits.get("timeline"), dict) else {}
    track_state = timeline.get("trackState") if isinstance(timeline.get("trackState"), dict) else {}
    keyframes = timeline.get("keyframes") if isinstance(timeline.get("keyframes"), dict) else {}
    state = track_state.get(track_id) if isinstance(track_state.get(track_id), dict) else {}
    visible = state.get("visible", True) is not False
    if not visible:
        return "off", []
    points = keyframes.get(track_id) if isinstance(keyframes.get(track_id), list) else []
    if len(points) < 2:
        # Backward-compatible default: no ranges configured means global.
        return "global", []
    ranges = _normalize_track_ranges(points, duration_seconds)
    if not ranges:
        return "off", []
    return "ranged", ranges


def _render_timeline_video(
    *,
    source_video_urls: List[str],
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

        # Download all source videos
        src_paths: List[Path] = []
        for i, url in enumerate(source_video_urls):
            sp = tmp_dir_path / f"source_{i}.mp4"
            download_video_to_file(url, sp, proxy)
            if not sp.exists() or sp.stat().st_size < 1024:
                raise ValueError(f"源视频 {i} 下载失败或内容为空 (url={url[:80]})")
            src_paths.append(sp)

        if on_progress:
            on_progress(30, "source_downloaded")

        # Use first source to determine timeline duration (for percent-based segments)
        if duration_hint is None:
            probe = subprocess.run(
                [
                    "ffprobe", "-v", "error",
                    "-show_entries", "format=duration",
                    "-of", "default=noprint_wrappers=1:nokey=1",
                    str(src_paths[0]),
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

        # Clamp out-of-bounds source_index to max valid index
        max_src_idx = len(src_paths) - 1
        for seg in normalized_segments:
            seg["source_index"] = int(min(seg.get("source_index", 0), max_src_idx))

        total_render_seconds = max(
            0.001,
            sum(max(0.0, float(seg["end"]) - float(seg["start"])) for seg in normalized_segments),
        )

        has_muted_video_track = any(
            isinstance(t, dict)
            and bool(t.get("enabled", True))
            and str(t.get("track_type") or "").strip().lower() in {"", "video"}
            and bool(t.get("muted", False))
            for t in tracks
        )
        effective_include_audio = include_audio and (not has_muted_video_track)

        # Probe audio for each source that is actually referenced by some segment
        referenced_src_indices = {seg["source_index"] for seg in normalized_segments}
        source_has_audio: Dict[int, bool] = {}
        if effective_include_audio:
            for idx in referenced_src_indices:
                source_has_audio[idx] = _probe_has_audio(src_paths[idx])
        # Audio output only when ALL referenced sources have audio
        has_audio = effective_include_audio and all(source_has_audio.get(i, False)
                                                    for i in referenced_src_indices)

        filter_parts = []
        for seg_idx, seg in enumerate(normalized_segments):
            s = _fmt_float(seg["start"], 4)
            e = _fmt_float(seg["end"], 4)
            si = seg["source_index"]
            filter_parts.append(f"[{si}:v]trim=start={s}:end={e},setpts=PTS-STARTPTS[v{seg_idx}]")
            if has_audio:
                filter_parts.append(f"[{si}:a]atrim=start={s}:end={e},asetpts=PTS-STARTPTS[a{seg_idx}]")

        n = len(normalized_segments)
        if has_audio:
            # concat(v=1,a=1) expects interleaved pads: [v0][a0][v1][a1]...
            va_inputs = "".join([f"[v{i}][a{i}]" for i in range(n)])
            filter_parts.append(f"{va_inputs}concat=n={n}:v=1:a=1[vout][aout]")
        else:
            v_inputs = "".join([f"[v{i}]" for i in range(n)])
            filter_parts.append(f"{v_inputs}concat=n={n}:v=1:a=0[vout]")

        if on_progress:
            on_progress(60, "ffmpeg_started")

        cmd = ["ffmpeg", "-y", "-nostats"]
        for sp in src_paths:
            cmd.extend(["-i", str(sp)])
        cmd.extend([
            "-filter_complex", ";".join(filter_parts),
            "-map", "[vout]",
            "-progress", "pipe:1",
            "-c:v", "libx264",
            "-preset", "veryfast",
            "-crf", "20",
        ])
        if has_audio:
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
            "source_count": len(src_paths),
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
    timeline_jobs: Dict[str, Dict] = {}
    timeline_jobs_lock = threading.Lock()
    TIMELINE_JOB_MAX = 200  # prevent unbounded memory growth

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

            sat_val = _clamp_num(edits.get("sat", 0), -30, 30, 0)
            vibrance_val = _clamp_num(edits.get("vibrance", 0), -30, 30, 0)
            temp_val = _clamp_num(edits.get("temp", 0), -30, 30, 0)
            tint_val = _clamp_num(edits.get("tint", 0), -30, 30, 0)
            mask_text = str(edits.get("maskText") or "").strip()
            mask_opacity = _clamp_num(edits.get("opacity", 90), 0, 100, 90) / 100.0
            _raw_color = str(edits.get("maskColor") or "#ffffff").strip()
            mask_color = _raw_color if _raw_color else "#ffffff"
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

                duration_probe = subprocess.run(
                    [
                        "ffprobe", "-v", "error",
                        "-show_entries", "format=duration",
                        "-of", "default=noprint_wrappers=1:nokey=1",
                        str(input_video),
                    ],
                    stdout=subprocess.PIPE,
                    stderr=subprocess.PIPE,
                    text=True,
                )
                duration_seconds = _clamp_num((duration_probe.stdout or "").strip(), 0.001, 7200, 60)

                motion_mode, motion_ranges = _resolve_track_mode(edits, "motion", duration_seconds)
                color_mode, color_ranges = _resolve_track_mode(edits, "color", duration_seconds)
                mask_mode, mask_ranges = _resolve_track_mode(edits, "mask", duration_seconds)
                bgm_mode, bgm_ranges = _resolve_track_mode(edits, "bgm", duration_seconds)

                speed = _clamp_num(edits.get("speed", 1), 0.5, 2.0, 1.0) if motion_mode != "off" else 1.0

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

                motion_enable_expr = _build_time_enable_expr(motion_ranges)
                if motion_mode == "ranged" and motion_enable_expr:
                    motion_pts_expr = motion_enable_expr.replace("between(t,", "between(T,")
                    video_filters = [
                        f"setpts='if(gt({motion_pts_expr},0),{_fmt_float(1.0 / speed, 4)}*PTS,PTS)'"
                    ]
                else:
                    video_filters = [f"setpts={_fmt_float(1.0 / speed, 4)}*PTS"]
                color_enable_expr = _build_time_enable_expr(color_ranges)
                if color_mode == "off":
                    video_filters.append("eq=saturation=1:brightness=0:contrast=1")
                    video_filters.append("hue=h=0")
                elif color_mode == "ranged" and color_enable_expr:
                    video_filters.append(
                        f"eq=saturation={_fmt_float(sat)}:brightness={_fmt_float(bright)}:contrast={_fmt_float(contrast)}:enable='{color_enable_expr}'"
                    )
                    video_filters.append(f"hue=h={_fmt_float(hue, 3)}:enable='{color_enable_expr}'")
                else:
                    video_filters.append(f"eq=saturation={_fmt_float(sat)}:brightness={_fmt_float(bright)}:contrast={_fmt_float(contrast)}")
                    video_filters.append(f"hue=h={_fmt_float(hue, 3)}")
                mask_applied = False
                mask_enable_expr = _build_time_enable_expr(mask_ranges)
                mask_allowed = mask_mode != "off"
                if mask_text and drawtext_available and mask_allowed:
                    safe_text = escape_drawtext_text(mask_text)
                    enable_clause = f":enable='{mask_enable_expr}'" if (mask_mode == "ranged" and mask_enable_expr) else ""
                    video_filters.append(
                        "drawtext="
                        f"text='{safe_text}':"
                        f"fontsize={text_size}:"
                        f"fontcolor={mask_color}:"
                        f"alpha={_fmt_float(mask_opacity, 3)}:"
                        f"x={text_x_expr}:"
                        f"y={text_y_expr}:"
                        "box=1:"
                        "boxcolor=black@0.28:"
                        f"boxborderw=14{enable_clause}"
                    )
                    mask_applied = True

                cmd = [
                    "ffmpeg",
                    "-y",
                    "-i",
                    str(input_video),
                ]
                use_bgm = bool(bgm_file and bgm_file.exists() and bgm_mode != "off")
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

                audio_speed = speed if motion_mode != "ranged" else 1.0
                atempo = _build_atempo_chain(audio_speed)
                bgm_enable_expr = _build_time_enable_expr(bgm_ranges)
                if bgm_mode == "ranged" and bgm_enable_expr:
                    bgm_volume_filter = f"volume='if(gt({bgm_enable_expr},0),{_fmt_float(bgm_volume, 3)},0)':eval=frame"
                else:
                    bgm_volume_filter = f"volume={_fmt_float(bgm_volume, 3)}"

                if use_bgm and has_input_audio:
                    filter_parts.append(f"[0:a]{atempo}[a0]")
                    filter_parts.append(f"[1:a]{bgm_volume_filter},{atempo}[a1]")
                    filter_parts.append("[a0][a1]amix=inputs=2:duration=first:dropout_transition=2[aout]")
                elif use_bgm and not has_input_audio:
                    filter_parts.append(f"[1:a]{bgm_volume_filter},{atempo}[aout]")
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
        req_obj = g.req  # VideoTimelineRenderRequest Pydantic instance
        try:
            # Resolve source URLs: source_videos takes precedence over source_video_url
            source_video_urls = req_obj.resolved_source_videos()

            payload = req_obj.model_dump()
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
                    # Evict oldest terminal jobs if limit reached
                    if len(timeline_jobs) >= TIMELINE_JOB_MAX:
                        terminal = [
                            (k, v.get("updated_at", 0)) for k, v in timeline_jobs.items()
                            if v.get("status") in {"done", "failed", "cancelled"}
                        ]
                        if terminal:
                            oldest_key = min(terminal, key=lambda x: x[1])[0]
                            del timeline_jobs[oldest_key]
                        else:
                            return json_error("异步任务队列已满，请稍后再试", 429)
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
                            source_video_urls=source_video_urls,
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
                                "source_count": result["source_count"],
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
                return jsonify({"ok": True, "async_job": True, "job_id": job_id, "status": "queued",
                                "source_count": len(source_video_urls)})

            result = _render_timeline_video(
                source_video_urls=source_video_urls,
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
                    "source_count": result["source_count"],
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

    @app.post("/api/video/asr")
    def api_video_asr():
        """Auto-generate timestamped subtitles from a video using Gemini vision.

        Request JSON:
            video_url   str   — URL of the video to transcribe (required)
            language    str   — "zh" | "en" (default "zh")
            max_lines   int   — max subtitle lines to return (default 20)
            project_id  str   — GCP project id (optional, falls back to env)
            key_file    str   — GCP service-account key path (optional)

        Response JSON:
            ok          bool
            subtitles   list of {start, end, text}
            raw_text    str   — raw Gemini output (debug)
        """
        import re as _re
        import requests as _req
        from shoplive.backend.infra import parse_common_payload, get_access_token

        payload = request.get_json(silent=True) or {}
        video_url = str(payload.get("video_url") or "").strip()
        language = str(payload.get("language") or "zh").strip().lower()
        max_lines = max(1, min(40, int(payload.get("max_lines") or 20)))

        if not video_url:
            from shoplive.backend.common.helpers import json_error
            return json_error("video_url 不能为空", error_code="MISSING_VIDEO_URL")

        try:
            project_id, key_file, proxy, _ = parse_common_payload(payload)
        except Exception:
            project_id, key_file, proxy = "", "", ""

        from shoplive.backend.common.helpers import json_error, download_video_to_file
        from shoplive.backend.infra import build_proxies

        try:
            # Download video to a temp file for base64 encoding
            with tempfile.TemporaryDirectory() as tmp_dir:
                tmp_path = Path(tmp_dir) / "asr_input.mp4"
                download_video_to_file(video_url, tmp_path, proxies=build_proxies(proxy))
                video_bytes = tmp_path.read_bytes()

            video_b64 = base64.b64encode(video_bytes).decode("ascii")
            mime_type = "video/mp4"

            # Limit upload size: skip if >20 MB (Gemini inline limit)
            if len(video_bytes) > 20 * 1024 * 1024:
                return json_error("视频文件过大（>20MB），暂不支持 ASR", error_code="VIDEO_TOO_LARGE")

            token = get_access_token(key_file, proxy)
            lang_name = "Chinese" if language == "zh" else "English"
            prompt = (
                f"Watch this video carefully and generate timestamped subtitles in {lang_name}. "
                f"Return up to {max_lines} lines. "
                "Format each line EXACTLY as: [START_SEC-END_SEC] TEXT\n"
                "Example: [0.0-3.5] 这是第一句字幕\n"
                "Rules:\n"
                "- START_SEC and END_SEC are floats in seconds from video start\n"
                "- If the video has no speech, return an empty list and say '无语音内容'\n"
                "- Do NOT add any extra explanation, only the timestamped lines\n"
            )
            gemini_model = "gemini-2.5-flash"
            location = "global"
            url = (
                f"https://aiplatform.googleapis.com/v1/projects/{project_id}"
                f"/locations/{location}/publishers/google/models/{gemini_model}:generateContent"
            )
            body = {
                "contents": [{
                    "role": "user",
                    "parts": [
                        {"inline_data": {"mime_type": mime_type, "data": video_b64}},
                        {"text": prompt},
                    ],
                }],
                "generation_config": {"temperature": 0.1, "max_output_tokens": 2048},
            }
            headers = {
                "Authorization": f"Bearer {token}",
                "Content-Type": "application/json; charset=utf-8",
            }
            proxies = build_proxies(proxy)
            resp = _req.post(url, json=body, headers=headers, proxies=proxies or None, timeout=120)
            resp.raise_for_status()
            data = resp.json()

            # Extract text from Gemini response
            raw_text = ""
            for cand in (data.get("candidates") or []):
                for part in (cand.get("content", {}).get("parts") or []):
                    raw_text += part.get("text", "")

            # Parse timestamped lines: [0.0-3.5] text
            LINE_PAT = _re.compile(r"\[(\d+(?:\.\d+)?)-(\d+(?:\.\d+)?)\]\s*(.+)")
            subtitles = []
            for line in raw_text.splitlines():
                m = LINE_PAT.search(line.strip())
                if m:
                    start = float(m.group(1))
                    end = float(m.group(2))
                    text = m.group(3).strip()
                    if end > start and text:
                        subtitles.append({"start": start, "end": end, "text": text})
                    if len(subtitles) >= max_lines:
                        break

            return jsonify({"ok": True, "subtitles": subtitles, "raw_text": raw_text})

        except Exception as exc:
            from shoplive.backend.common.helpers import json_error
            return json_error(f"ASR 失败: {exc}", 500, error_code="ASR_FAILED")

