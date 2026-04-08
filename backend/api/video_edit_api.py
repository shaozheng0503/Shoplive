import base64
import hashlib
import logging
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

# ASR subtitle cache: avoids re-calling Gemini for the same video.
# Key: (url_sha256_prefix, language, max_lines)  Value: (subtitles, raw_text, created_at)
_ASR_CACHE: Dict[tuple, tuple] = {}
_ASR_CACHE_TTL = 24 * 60 * 60  # 24 h

from flask import g, jsonify, request

from shoplive.backend.audit import AuditedOp
from shoplive.backend.schemas import VideoEditExportRequest, VideoTimelineRenderRequest
from shoplive.backend.validation import validate_request

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Text-overlay preset style → ffmpeg drawtext parameter mapping
# Approximates the 8 CSS presets from video-editor-ui.js in ffmpeg drawtext syntax.
# ---------------------------------------------------------------------------
_DRAWTEXT_STYLE_PARAMS: Dict[str, dict] = {
    # box=0: transparent background; shadow for legibility
    "elegant":   dict(box=0, shadowx=2,  shadowy=2,  shadowcolor="black@0.55"),
    # heavy dark background box, no shadow
    "bold":      dict(box=1, boxcolor="black@0.78",     boxborderw=18, shadowx=0, shadowy=0),
    # soft blue-tinted background, subtle shadow
    "soft":      dict(box=1, boxcolor="0x7890FF@0.22",  boxborderw=20, shadowx=1, shadowy=1, shadowcolor="black@0.35"),
    # no background; glow shadow in text colour (shadow matches fontcolor at call-time)
    "neon":      dict(box=0, shadowx=4,  shadowy=4,  shadowcolor="MATCH_FONTCOLOR"),
    # gold-tinted box, golden shadow
    "luxury":    dict(box=1, boxcolor="0xD4AF64@0.18",  boxborderw=14, shadowx=2, shadowy=2, shadowcolor="0xD4AF6A@0.75"),
    # bare text, no box, no shadow — clean minimal look
    "minimal":   dict(box=0, shadowx=0,  shadowy=0),
    # stamp-like: no fill, light outline effect via white shadow
    "stamp":     dict(box=0, shadowx=1,  shadowy=1,  shadowcolor="white@0.8"),
    # cinematic: full black bar (large padding), no shadow
    "cinematic": dict(box=1, boxcolor="black@0.82",     boxborderw=44, shadowx=0, shadowy=0),
}

# ---------------------------------------------------------------------------
# Font key → ordered list of candidate file paths (first existing one wins)
# ---------------------------------------------------------------------------
_FONT_CANDIDATES: Dict[str, List[str]] = {
    # sans-serif (CJK-capable)
    "sans":    [
        "/System/Library/Fonts/STHeiti Light.ttc",          # macOS CJK
        "/System/Library/Fonts/Supplemental/Arial.ttf",     # macOS ASCII
        "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",  # Linux
        "/usr/share/fonts/dejavu/DejaVuSans.ttf",
    ],
    # serif (CJK-capable via Songti)
    "serif":   [
        "/System/Library/Fonts/Supplemental/Songti.ttc",
        "/System/Library/Fonts/Supplemental/Times New Roman.ttf",
        "/usr/share/fonts/truetype/dejavu/DejaVuSerif.ttf",
        "/usr/share/fonts/dejavu/DejaVuSerif.ttf",
    ],
    # kai (cursive CJK)
    "kai":     [
        "/System/Library/Fonts/STHeiti Medium.ttc",
        "/System/Library/Fonts/STHeiti Light.ttc",
        "/System/Library/Fonts/Supplemental/Arial.ttf",
    ],
    # impact / heavy headline
    "impact":  [
        "/System/Library/Fonts/Supplemental/Impact.ttf",
        "/usr/share/fonts/truetype/msttcorefonts/Impact.ttf",
        "/usr/share/fonts/impact.ttf",
    ],
    # rounded
    "rounded": [
        "/System/Library/Fonts/SFNSRounded.ttf",
        "/System/Library/Fonts/Avenir Next.ttc",
        "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
    ],
    # monospace
    "mono":    [
        "/System/Library/Fonts/Supplemental/Courier New.ttf",
        "/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf",
        "/usr/share/fonts/dejavu/DejaVuSansMono.ttf",
    ],
}


def _resolve_font_path(font_key: str) -> str:
    """Return first existing font file path for key, or '' (ffmpeg uses default)."""
    for p in _FONT_CANDIDATES.get(font_key or "sans", []):
        if Path(p).exists():
            return p
    return ""


def _build_drawtext_filter(
    text: str,
    fontsize: int,
    fontcolor: str,
    alpha: float,
    x_expr: str,
    y_expr: str,
    mask_style: str,
    mask_font: str,
    enable_clause: str = "",
) -> str:
    """Build a complete ffmpeg drawtext filter string with preset style + font."""
    style = _DRAWTEXT_STYLE_PARAMS.get(mask_style, _DRAWTEXT_STYLE_PARAMS["elegant"])
    fontfile = _resolve_font_path(mask_font)
    fontfile_clause = f"fontfile='{fontfile}':" if fontfile else ""

    # For neon: shadow colour matches font colour to create glow effect
    shadow_color = style.get("shadowcolor", "black@0.55")
    if shadow_color == "MATCH_FONTCOLOR":
        shadow_color = f"{fontcolor}@0.9"

    parts = [
        f"text='{text}'",
        f"{fontfile_clause}fontsize={fontsize}",
        f"fontcolor={fontcolor}",
        f"alpha={_fmt_float(alpha, 3)}",
        f"x={x_expr}",
        f"y={y_expr}",
    ]
    # Box / background
    if style.get("box", 0):
        parts.append("box=1")
        parts.append(f"boxcolor={style.get('boxcolor', 'black@0.5')}")
        parts.append(f"boxborderw={style.get('boxborderw', 14)}")
    else:
        parts.append("box=0")
    # Shadow
    sx = style.get("shadowx", 0)
    sy = style.get("shadowy", 0)
    if sx or sy:
        parts.append(f"shadowx={sx}:shadowy={sy}:shadowcolor={shadow_color}")
    if enable_clause:
        parts.append(enable_clause.lstrip(":"))
    return "drawtext=" + ":".join(parts)


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
        video_url = str(payload.get("video_url") or "").strip()
        op = AuditedOp("video_edit", "export", {
            "video_url_len": len(video_url),
            "has_edits": bool(payload.get("edits")),
        })
        try:
            if not video_url:
                op.error("video_url 不能为空", "MISSING_VIDEO_URL")
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
            contrast_adj = _clamp_num(edits.get("contrast", 0), -30, 30, 0)
            mask_text = str(edits.get("maskText") or "").strip()
            mask_alpha = _clamp_num(edits.get("opacity", 90), 0, 100, 90) / 100.0  # 0.0-1.0
            _raw_color = str(edits.get("maskColor") or "#ffffff").strip()
            mask_color = _raw_color if _raw_color else "#ffffff"
            x_pct = _clamp_num(edits.get("x", 50), 0, 100, 50)
            y_pct = _clamp_num(edits.get("y", 88), 0, 100, 88)
            h_pct = _clamp_num(edits.get("h", 14), 6, 60, 14)
            bgm_extract = bool(edits.get("bgmExtract"))
            bgm_volume = _clamp_num(edits.get("bgmVolume", 70), 0, 100, 70) / 100.0
            local_bgm_data_url = str(edits.get("localBgmDataUrl") or "").strip()
            bgm_mood = str(edits.get("bgmMood") or "elegant").strip()
            _AUDIO_DIR = Path(__file__).parent.parent.parent / "frontend" / "assets" / "audio"
            _BGM_PRESET_FILES = {
                "elegant":   _AUDIO_DIR / "bgm-elegant.mp3",
                "daily":     _AUDIO_DIR / "bgm-daily.mp3",
                "piano":     _AUDIO_DIR / "bgm-piano.mp3",
                "energetic": _AUDIO_DIR / "bgm-energetic.mp3",
                "happy":     _AUDIO_DIR / "bgm-happy.mp3",
                "calm":      _AUDIO_DIR / "bgm-calm.mp3",
                "trendy":    _AUDIO_DIR / "bgm-trendy.mp3",
                "romantic":  _AUDIO_DIR / "bgm-romantic.mp3",
            }
            bgm_preset_path = _BGM_PRESET_FILES.get(bgm_mood)

            sat = _clamp_num((100 + sat_val * 3) / 100.0, 0.2, 2.6, 1.0)
            bright = _clamp_num((100 + vibrance_val * 2 - 100) / 100.0, -0.6, 1.2, 0.0)
            # Contrast: temperature bias (abs(temp) desaturates → more contrast)
            # multiplied by a direct contrast_adj term so the two controls are independent.
            temp_contrast  = 1.0 + abs(temp_val) * 0.012   # 0→1.0, 30→1.36
            direct_contrast = 1.0 + contrast_adj * 0.015   # -30→0.55, 0→1.0, 30→1.45
            contrast = _clamp_num(temp_contrast * direct_contrast, 0.2, 3.0, 1.0)
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
                elif bgm_extract and bgm_preset_path and bgm_preset_path.exists():
                    bgm_file = bgm_preset_path

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
                # Fade in / fade out — applied after colour grading, before text.
                # Guard: if fadeIn + fadeOut >= duration, scale both proportionally so
                # they never overlap (each gets at most half the video duration).
                fade_in  = _clamp_num(edits.get("fadeIn",  0), 0, 3.0, 0)
                fade_out = _clamp_num(edits.get("fadeOut", 0), 0, 3.0, 0)
                _fade_total = fade_in + fade_out
                if _fade_total > 0 and _fade_total >= duration_seconds:
                    _scale = (duration_seconds * 0.9) / _fade_total  # leave 10% solid
                    fade_in  = round(fade_in  * _scale, 3)
                    fade_out = round(fade_out * _scale, 3)
                if fade_in > 0:
                    video_filters.append(f"fade=t=in:st=0:d={_fmt_float(fade_in, 3)}")
                if fade_out > 0:
                    _fo_start = _fmt_float(max(0.0, duration_seconds - fade_out), 3)
                    video_filters.append(f"fade=t=out:st={_fo_start}:d={_fmt_float(fade_out, 3)}")

                mask_style = str(edits.get("maskStyle") or "elegant").strip()
                mask_font  = str(edits.get("maskFont")  or "sans").strip()
                mask_applied = False
                mask_enable_expr = _build_time_enable_expr(mask_ranges)
                mask_allowed = mask_mode != "off"
                if mask_text and drawtext_available and mask_allowed:
                    safe_text    = escape_drawtext_text(mask_text)
                    enable_clause = f":enable='{mask_enable_expr}'" if (mask_mode == "ranged" and mask_enable_expr) else ""
                    video_filters.append(_build_drawtext_filter(
                        text=safe_text, fontsize=text_size,
                        fontcolor=mask_color, alpha=mask_alpha,
                        x_expr=text_x_expr, y_expr=text_y_expr,
                        mask_style=mask_style, mask_font=mask_font,
                        enable_clause=enable_clause,
                    ))
                    mask_applied = True

                # Batch ASR subtitles — each item: {text, start, end}
                raw_subtitles = edits.get("subtitles") if isinstance(edits.get("subtitles"), list) else []
                if raw_subtitles and drawtext_available:
                    for sub in raw_subtitles[:30]:
                        sub_text = str(sub.get("text") or "").strip() if isinstance(sub, dict) else ""
                        if not sub_text:
                            continue
                        try:
                            sub_start = max(0.0, float(sub.get("start") or 0))
                            sub_end   = max(sub_start + 0.05, float(sub.get("end") or sub_start + 2))
                        except (TypeError, ValueError):
                            continue
                        safe_sub = escape_drawtext_text(sub_text)
                        enable_sub = f":enable='between(t,{_fmt_float(sub_start, 3)},{_fmt_float(sub_end, 3)})'"
                        video_filters.append(_build_drawtext_filter(
                            text=safe_sub, fontsize=text_size,
                            fontcolor=mask_color, alpha=mask_alpha,
                            x_expr=text_x_expr, y_expr=text_y_expr,
                            mask_style=mask_style, mask_font=mask_font,
                            enable_clause=enable_sub,
                        ))
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

                if use_bgm:
                    # Replace original audio with BGM (discard original audio track)
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

            base = ""
            warning = ""
            if mask_text and not mask_applied:
                warning = "当前 ffmpeg 不支持 drawtext，文字蒙版未写入导出视频"
            op.success({"file_name": output_name, "mask_applied": mask_applied,
                        "speed": speed, "duration_seconds": duration_seconds})
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
            op.error(e, "VALUE_ERROR")
            return json_error(str(e))
        except subprocess.TimeoutExpired:
            op.error("timeout", "TIMEOUT")
            return json_error("视频导出超时，请缩短视频时长或减少编辑项", 500)
        except Exception as e:
            op.error(e, "EXPORT_FAILED")
            return json_error(f"视频导出失败: {e}", 500)

    @app.post("/api/video/timeline/render")
    @validate_request(VideoTimelineRenderRequest)
    def api_video_timeline_render():
        req_obj = g.req  # VideoTimelineRenderRequest Pydantic instance
        source_video_urls = []  # init before try to avoid UnboundLocalError in except
        op = AuditedOp("video_timeline_render", "render")
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
            base = ""

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
                op.input_summary = {"source_count": len(source_video_urls),
                                    "track_count": len(tracks), "sort_strategy": sort_strategy}
                op.success({"job_id": job_id, "async_job": True})
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

            op.input_summary = {"source_count": len(source_video_urls), "track_count": len(tracks),
                                "sort_strategy": sort_strategy, "include_audio": include_audio}
            op.success({"file_name": output_name, "segments_rendered": result["segments_rendered"],
                        "duration": result["timeline_duration_seconds"]})
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
        except (ValueError, subprocess.TimeoutExpired, Exception) as e:
            op.input_summary["source_count"] = len(source_video_urls)
            if isinstance(e, ValueError):
                op.error(e, "VALUE_ERROR")
                return json_error(str(e))
            if isinstance(e, subprocess.TimeoutExpired):
                op.error("timeout", "TIMEOUT")
                return json_error("时间线渲染超时，请缩短片段数量或时长", 500)
            op.error(e, "RENDER_FAILED")
            return json_error(f"时间线渲染失败: {e}", 500)

    @app.get("/api/video/timeline/render/status")
    def api_video_timeline_render_status():
        op = AuditedOp("video_timeline_status", "query")
        job_id = str(request.args.get("job_id") or "").strip()
        if not job_id:
            op.error("missing job_id", "MISSING_JOB_ID")
            return json_error("job_id 不能为空")
        op.input_summary = {"job_id": job_id}
        with timeline_jobs_lock:
            job = timeline_jobs.get(job_id)
            if not job:
                op.error("job not found", "JOB_NOT_FOUND")
                return json_error("job 不存在", 404)
            op.success({"status": job.get("status"), "progress": int(job.get("progress", 0))})
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
        op = AuditedOp("video_timeline_cancel", "cancel")
        payload = request.get_json(silent=True) or {}
        job_id = str(payload.get("job_id") or "").strip()
        if not job_id:
            op.error("missing job_id", "MISSING_JOB_ID")
            return json_error("job_id 不能为空")
        op.input_summary = {"job_id": job_id}
        with timeline_jobs_lock:
            job = timeline_jobs.get(job_id)
            if not job:
                op.error("job not found", "JOB_NOT_FOUND")
                return json_error("job 不存在", 404)
            if job.get("status") in {"done", "failed", "cancelled"}:
                op.success({"status": job.get("status"), "already_terminal": True})
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
        op.success({"status": "cancelling", "pid_killed": bool(pid)})
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
        _asr_key = (hashlib.sha256(video_url.encode()).hexdigest()[:20], language, max_lines)
        _cached = _ASR_CACHE.get(_asr_key)
        if _cached:
            _subs, _raw, _ts = _cached
            if time.time() - _ts < _ASR_CACHE_TTL:
                return jsonify({"ok": True, "subtitles": _subs, "raw_text": _raw, "cached": True})
            del _ASR_CACHE[_asr_key]

        op = AuditedOp("video_asr", "transcribe", {"video_url_len": len(video_url), "language": language})

        if not video_url:
            from shoplive.backend.common.helpers import json_error
            op.error("missing video_url", "MISSING_VIDEO_URL")
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
                download_video_to_file(video_url, tmp_path, proxy)
                video_bytes = tmp_path.read_bytes()

            video_b64 = base64.b64encode(video_bytes).decode("ascii")
            mime_type = "video/mp4"

            # Limit upload size: skip if >20 MB (Gemini inline limit)
            if len(video_bytes) > 20 * 1024 * 1024:
                op.error("video >20MB", "VIDEO_TOO_LARGE")
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

            _ASR_CACHE[_asr_key] = (subtitles, raw_text, time.time())
            op.success({"subtitle_count": len(subtitles)})
            return jsonify({"ok": True, "subtitles": subtitles, "raw_text": raw_text})

        except Exception as exc:
            from shoplive.backend.common.helpers import json_error
            op.error(exc, "ASR_FAILED")
            return json_error(f"ASR 失败: {exc}", 500, error_code="ASR_FAILED")

    @app.post("/api/video/overlay-image")
    def api_video_overlay_image():
        """Overlay a product image on top of a video using ffmpeg.

        Request JSON:
            video_url       str   — source video URL (required)
            image_base64    str   — base64-encoded image (PNG/JPEG, optional)
            image_url       str   — image HTTP URL (optional if image_base64 not given)
            image_mime_type str   — "image/png" | "image/jpeg" (default "image/png")
            overlay_scale   float — overlay width as fraction of video width 0.05-1.0 (default 0.35)
            overlay_position str  — "top-left"|"top-right"|"center"|"bottom-left"|"bottom-right" (default "top-right")
            overlay_duration float — seconds to show overlay; 0 = entire video (default 0)
            padding         int   — edge padding in pixels (default 20)
            proxy           str   — optional proxy URL

        Response JSON:
            ok, video_url, file_name
        """
        from shoplive.backend.common.helpers import json_error, download_video_to_file
        from shoplive.backend.infra import build_proxies, parse_common_payload
        import requests as _req

        payload = request.get_json(silent=True) or {}
        video_url = str(payload.get("video_url") or "").strip()
        if not video_url:
            return json_error("video_url 不能为空", error_code="MISSING_VIDEO_URL")

        image_b64 = str(payload.get("image_base64") or "").strip()
        image_url_src = str(payload.get("image_url") or "").strip()
        image_mime = str(payload.get("image_mime_type") or "image/png").strip()
        if image_mime not in {"image/png", "image/jpeg"}:
            image_mime = "image/png"

        try:
            overlay_scale = max(0.05, min(1.0, float(payload.get("overlay_scale") or 0.35)))
        except Exception:
            overlay_scale = 0.35
        overlay_position = str(payload.get("overlay_position") or "top-right").strip()
        try:
            overlay_duration = max(0.0, float(payload.get("overlay_duration") or 0))
        except Exception:
            overlay_duration = 0.0
        try:
            padding = max(0, int(payload.get("padding") or 20))
        except Exception:
            padding = 20

        proxy = str(payload.get("proxy") or "").strip()
        proxies = build_proxies(proxy)

        POSITION_MAP = {
            "top-left":     f"{padding}:{padding}",
            "top-right":    f"W-w-{padding}:{padding}",
            "center":       "(W-w)/2:(H-h)/2",
            "bottom-left":  f"{padding}:H-h-{padding}",
            "bottom-right": f"W-w-{padding}:H-h-{padding}",
        }
        pos_expr = POSITION_MAP.get(overlay_position, POSITION_MAP["top-right"])

        try:
            # Resolve image data
            if not image_b64 and image_url_src:
                from shoplive.backend.common.helpers import fetch_image_as_base64
                image_b64, image_mime = fetch_image_as_base64(image_url_src, proxy)
            if not image_b64:
                return json_error("image_base64 或 image_url 至少提供一个", error_code="MISSING_IMAGE")

            # Decode base64 header if present
            if "," in image_b64:
                image_b64 = image_b64.split(",", 1)[1]
            img_bytes = base64.b64decode(image_b64)
            img_ext = "png" if "png" in image_mime else "jpg"

            with tempfile.TemporaryDirectory() as tmp_dir:
                tmp = Path(tmp_dir)
                video_path = tmp / "input.mp4"
                img_path = tmp / f"overlay.{img_ext}"

                download_video_to_file(video_url, video_path, proxy)
                img_path.write_bytes(img_bytes)

                output_name = f"overlay-{uuid.uuid4().hex}.mp4"
                output_path = video_edit_export_dir / output_name

                scale_filter = f"[1:v]scale=iw*{overlay_scale:.3f}:-1[img]"
                enable_expr = (
                    f":enable='between(t,0,{overlay_duration:.3f})'"
                    if overlay_duration > 0
                    else ""
                )
                overlay_filter = f"[0:v][img]overlay={pos_expr}{enable_expr}[out]"
                filter_complex = f"{scale_filter};{overlay_filter}"

                cmd = [
                    "ffmpeg", "-y",
                    "-i", str(video_path),
                    "-i", str(img_path),
                    "-filter_complex", filter_complex,
                    "-map", "[out]",
                    "-map", "0:a?",
                    "-c:a", "copy",
                    "-c:v", "libx264",
                    "-preset", "fast",
                    "-crf", "23",
                    "-movflags", "+faststart",
                    str(output_path),
                ]
                result = subprocess.run(cmd, capture_output=True, text=True, timeout=120)
                if result.returncode != 0:
                    return json_error(f"ffmpeg overlay 失败: {result.stderr[-300:]}", 500, error_code="FFMPEG_OVERLAY_FAILED")

            base_url = ""
            return jsonify({
                "ok": True,
                "video_url": f"{base_url}/video-edits/{output_name}",
                "file_name": output_name,
            })

        except Exception as exc:
            return json_error(f"overlay 失败: {exc}", 500, error_code="OVERLAY_FAILED")

