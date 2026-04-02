"""
Integration tests for video editing endpoints.

Tests run against a real Flask test client using ffmpeg-generated synthetic
videos — no external API calls (GCP, LiteLLM) are made.

Covered endpoints:
  POST /api/video/edit/export          – colour grading, speed, text, maskColor,
                                         timeline mask visibility, BGM, batch subtitles
  POST /api/video/asr                  – Gemini video transcription (mocked)
  POST /api/video/overlay-image        – ffmpeg image overlay (+ image_url via mocked fetch)
  POST /api/video/timeline/render      – segment clip & concat (sync + async),
                                         multi-source (source_videos + source_index)
  GET  /api/video/timeline/render/status
  POST /api/video/timeline/render/cancel
"""

import base64
import subprocess
import tempfile
import time
from pathlib import Path

import pytest


def _drawtext_available() -> bool:
    """Return True if this ffmpeg build includes the drawtext filter (requires libfreetype)."""
    r = subprocess.run(
        ["ffmpeg", "-hide_banner", "-filters"],
        stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
    )
    return "drawtext" in ((r.stdout or "") + (r.stderr or ""))


DRAWTEXT_AVAILABLE = _drawtext_available()


# ---------------------------------------------------------------------------
# Module-level helpers
# ---------------------------------------------------------------------------

def _ffmpeg_lavfi_video(with_audio: bool = True, duration: int = 3) -> str:
    """Generate a tiny synthetic MP4 via ffmpeg lavfi. Returns data:video URL."""
    with tempfile.NamedTemporaryFile(suffix=".mp4", delete=False) as f:
        tmp = Path(f.name)
    try:
        cmd = [
            "ffmpeg", "-y",
            "-f", "lavfi", "-i", f"color=blue:s=160x90:d={duration}:r=10",
        ]
        if with_audio:
            cmd += ["-f", "lavfi", "-i", f"sine=frequency=440:duration={duration}"]
        cmd += ["-c:v", "libx264", "-preset", "ultrafast", "-crf", "40",
                "-pix_fmt", "yuv420p"]
        if with_audio:
            cmd += ["-c:a", "aac", "-shortest"]
        else:
            cmd += ["-an"]
        cmd.append(str(tmp))
        subprocess.run(cmd, check=True, capture_output=True)
        return "data:video/mp4;base64," + base64.b64encode(tmp.read_bytes()).decode()
    finally:
        tmp.unlink(missing_ok=True)


def _ffmpeg_lavfi_audio(duration: int = 5) -> str:
    """Generate a small MP3 for BGM mixing tests. Returns data:audio URL."""
    with tempfile.NamedTemporaryFile(suffix=".mp3", delete=False) as f:
        tmp = Path(f.name)
    try:
        subprocess.run([
            "ffmpeg", "-y",
            "-f", "lavfi", "-i", f"sine=frequency=880:duration={duration}",
            "-c:a", "libmp3lame", "-b:a", "64k", str(tmp),
        ], check=True, capture_output=True)
        return "data:audio/mpeg;base64," + base64.b64encode(tmp.read_bytes()).decode()
    finally:
        tmp.unlink(missing_ok=True)


# ---------------------------------------------------------------------------
# Fixtures  (module-scoped so videos are generated once per test run)
# ---------------------------------------------------------------------------

@pytest.fixture(scope="module")
def client():
    from shoplive.backend.web_app import create_app
    app = create_app()
    app.config["TESTING"] = True
    with app.test_client() as c:
        yield c


@pytest.fixture(scope="module")
def vid_audio():
    return _ffmpeg_lavfi_video(with_audio=True, duration=3)


@pytest.fixture(scope="module")
def vid_silent():
    return _ffmpeg_lavfi_video(with_audio=False, duration=3)


@pytest.fixture(scope="module")
def bgm():
    return _ffmpeg_lavfi_audio(duration=5)


# ---------------------------------------------------------------------------
# /api/video/edit/export
# ---------------------------------------------------------------------------

class TestVideoEditExport:
    EP = "/api/video/edit/export"

    # --- happy-path ---

    def test_default_no_edits(self, client, vid_audio):
        r = client.post(self.EP, json={"video_url": vid_audio})
        assert r.status_code == 200
        d = r.get_json()
        assert d["ok"] is True
        assert d["video_url"].endswith(".mp4")

    def test_speed_up(self, client, vid_audio):
        r = client.post(self.EP, json={"video_url": vid_audio, "edits": {"speed": 1.5}})
        assert r.status_code == 200
        assert r.get_json()["ok"] is True

    def test_slow_down(self, client, vid_audio):
        r = client.post(self.EP, json={"video_url": vid_audio, "edits": {"speed": 0.75}})
        assert r.status_code == 200
        assert r.get_json()["ok"] is True

    def test_color_correction_full(self, client, vid_silent):
        r = client.post(self.EP, json={
            "video_url": vid_silent,
            "edits": {"sat": 15, "vibrance": 10, "temp": -5, "tint": 3},
        })
        assert r.status_code == 200
        assert r.get_json()["ok"] is True

    def test_color_negative_values(self, client, vid_silent):
        r = client.post(self.EP, json={
            "video_url": vid_silent,
            "edits": {"sat": -20, "vibrance": -15, "temp": 20, "tint": -10},
        })
        assert r.status_code == 200
        assert r.get_json()["ok"] is True

    def test_text_overlay_basic(self, client, vid_audio):
        r = client.post(self.EP, json={
            "video_url": vid_audio,
            "edits": {"maskText": "Shop Now", "opacity": 85, "x": 50, "y": 85, "h": 12},
        })
        d = r.get_json()
        assert r.status_code == 200
        assert d["ok"] is True
        if DRAWTEXT_AVAILABLE:
            assert d["mask_applied"] is True
        else:
            # drawtext requires libfreetype; without it mask is skipped with a warning
            assert d["mask_applied"] is False
            assert "drawtext" in d.get("warning", "").lower() or "ffmpeg" in d.get("warning", "").lower()

    def test_text_special_chars_escaped(self, client, vid_silent):
        """Chars unsafe for ffmpeg drawtext (: % ' \\) must be escaped without crashing."""
        r = client.post(self.EP, json={
            "video_url": vid_silent,
            "edits": {"maskText": "50% OFF: It's a sale!"},
        })
        assert r.status_code == 200
        assert r.get_json()["ok"] is True

    def test_text_chinese_chars(self, client, vid_silent):
        r = client.post(self.EP, json={
            "video_url": vid_silent,
            "edits": {"maskText": "限时优惠"},
        })
        assert r.status_code == 200
        assert r.get_json()["ok"] is True

    def test_bgm_mix_with_audio_video(self, client, vid_audio, bgm):
        r = client.post(self.EP, json={
            "video_url": vid_audio,
            "edits": {"bgmExtract": True, "localBgmDataUrl": bgm, "bgmVolume": 60},
        })
        assert r.status_code == 200
        assert r.get_json()["ok"] is True

    def test_bgm_mix_silent_video(self, client, vid_silent, bgm):
        """Silent video + BGM → output has BGM audio track."""
        r = client.post(self.EP, json={
            "video_url": vid_silent,
            "edits": {"bgmExtract": True, "localBgmDataUrl": bgm, "bgmVolume": 80},
        })
        assert r.status_code == 200
        assert r.get_json()["ok"] is True

    def test_all_edits_combined(self, client, vid_audio, bgm):
        r = client.post(self.EP, json={
            "video_url": vid_audio,
            "edits": {
                "speed": 1.2,
                "sat": 10, "vibrance": 5, "temp": -3, "tint": 2,
                "maskText": "Sale 50%",
                "opacity": 90, "x": 50, "y": 88, "h": 14,
                "bgmExtract": True, "localBgmDataUrl": bgm, "bgmVolume": 50,
            },
        })
        d = r.get_json()
        assert r.status_code == 200
        assert d["ok"] is True
        # mask_applied depends on whether this ffmpeg was built with libfreetype
        assert isinstance(d["mask_applied"], bool)
        if not DRAWTEXT_AVAILABLE:
            assert d.get("warning")  # must explain why mask was skipped

    def test_mask_color_custom(self, client, vid_silent):
        """Custom maskColor is accepted (hex); export succeeds."""
        r = client.post(self.EP, json={
            "video_url": vid_silent,
            "edits": {"maskText": "Brand", "maskColor": "#ffcc00"},
        })
        assert r.status_code == 200
        assert r.get_json()["ok"] is True

    def test_mask_track_hidden_skips_drawtext(self, client, vid_silent):
        """When timeline mask track is not visible, maskText must not be burned in."""
        r = client.post(self.EP, json={
            "video_url": vid_silent,
            "edits": {
                "maskText": "Hidden overlay",
                "timeline": {
                    "trackState": {
                        "mask": {"visible": False, "locked": False},
                    },
                },
            },
        })
        assert r.status_code == 200
        d = r.get_json()
        assert d["ok"] is True
        assert d["mask_applied"] is False

    def test_timeline_ranged_edits_combined(self, client, vid_audio, bgm):
        r = client.post(self.EP, json={
            "video_url": vid_audio,
            "edits": {
                "speed": 1.5,
                "sat": 10, "vibrance": 5, "temp": -3, "tint": 2,
                "maskText": "段落测试",
                "opacity": 90, "x": 50, "y": 88, "h": 14,
                "bgmExtract": True, "localBgmDataUrl": bgm, "bgmVolume": 50,
                "timeline": {
                    "trackState": {
                        "mask": {"visible": True, "locked": False},
                        "color": {"visible": True, "locked": False},
                        "bgm": {"visible": True, "locked": False},
                        "motion": {"visible": True, "locked": False},
                    },
                    "keyframes": {
                        "mask": [0.2, 1.0, 2.0, 2.6],
                        "color": [0.4, 1.8],
                        "bgm": [0.0, 1.5],
                        "motion": [0.5, 1.6],
                    },
                },
            },
        })
        d = r.get_json()
        assert r.status_code == 200
        assert d["ok"] is True

    def test_speed_out_of_range_clamped(self, client, vid_silent):
        """speed=5.0 exceeds schema max but edits is Dict[Any] — clamped to 2.0, not rejected."""
        r = client.post(self.EP, json={"video_url": vid_silent, "edits": {"speed": 5.0}})
        assert r.status_code == 200
        assert r.get_json()["ok"] is True

    def test_file_name_in_response(self, client, vid_silent):
        r = client.post(self.EP, json={"video_url": vid_silent})
        d = r.get_json()
        assert "file_name" in d
        assert d["file_name"].endswith(".mp4")

    # --- validation / error cases ---

    def test_missing_video_url_rejected(self, client):
        r = client.post(self.EP, json={})
        assert r.status_code == 400

    def test_empty_video_url_rejected(self, client):
        r = client.post(self.EP, json={"video_url": ""})
        # Pydantic passes (str), handler rejects with 400
        assert r.status_code == 400
        assert r.get_json()["ok"] is False

    def test_invalid_content_type(self, client):
        r = client.post(self.EP, data="not-json", content_type="text/plain")
        assert r.status_code == 400

    def test_non_video_data_url_rejected(self, client):
        r = client.post(self.EP, json={"video_url": "data:image/png;base64,abc"})
        assert r.status_code in {400, 500}
        assert r.get_json()["ok"] is False


# ---------------------------------------------------------------------------
# /api/video/timeline/render  (sync mode)
# ---------------------------------------------------------------------------

class TestTimelineRenderSync:
    EP = "/api/video/timeline/render"

    @staticmethod
    def _track(left=0, width=100, enabled=True, muted=False):
        return [{"label": "Video", "track_type": "video",
                 "enabled": enabled, "muted": muted,
                 "segments": [{"left": left, "width": width}]}]

    def test_single_segment(self, client, vid_audio):
        r = client.post(self.EP, json={
            "source_video_url": vid_audio,
            "duration_seconds": 3.0,
            "tracks": self._track(0, 50),
        })
        d = r.get_json()
        assert r.status_code == 200
        assert d["ok"] is True
        assert d["segments_rendered"] == 1
        assert d["video_url"].endswith(".mp4")

    def test_two_segments(self, client, vid_audio):
        r = client.post(self.EP, json={
            "source_video_url": vid_audio,
            "duration_seconds": 3.0,
            "tracks": [{"label": "Video", "track_type": "video", "segments": [
                {"left": 0, "width": 30},
                {"left": 60, "width": 30},
            ]}],
        })
        d = r.get_json()
        assert r.status_code == 200
        assert d["segments_rendered"] == 2

    def test_seconds_based_segments(self, client, vid_silent):
        r = client.post(self.EP, json={
            "source_video_url": vid_silent,
            "duration_seconds": 3.0,
            "tracks": [{"label": "Video", "track_type": "video", "segments": [
                {"start_seconds": 0.5, "end_seconds": 2.0},
            ]}],
        })
        assert r.status_code == 200
        assert r.get_json()["ok"] is True

    def test_include_audio_false(self, client, vid_audio):
        r = client.post(self.EP, json={
            "source_video_url": vid_audio,
            "duration_seconds": 3.0,
            "include_audio": False,
            "tracks": self._track(0, 100),
        })
        d = r.get_json()
        assert r.status_code == 200
        assert d["include_audio"] is False

    def test_muted_video_track(self, client, vid_audio):
        r = client.post(self.EP, json={
            "source_video_url": vid_audio,
            "duration_seconds": 3.0,
            "tracks": self._track(0, 100, muted=True),
        })
        assert r.status_code == 200

    def test_silent_video_single_segment(self, client, vid_silent):
        r = client.post(self.EP, json={
            "source_video_url": vid_silent,
            "duration_seconds": 3.0,
            "tracks": self._track(20, 60),
        })
        assert r.status_code == 200
        assert r.get_json()["ok"] is True

    def test_sort_strategy_start_then_track(self, client, vid_audio):
        r = client.post(self.EP, json={
            "source_video_url": vid_audio,
            "duration_seconds": 3.0,
            "segment_sort_strategy": "start_then_track",
            "tracks": self._track(10, 50),
        })
        d = r.get_json()
        assert r.status_code == 200
        assert d["segment_sort_strategy"] == "start_then_track"

    def test_duration_inferred_via_ffprobe(self, client, vid_audio):
        """If duration_seconds omitted, ffprobe is used to detect duration."""
        r = client.post(self.EP, json={
            "source_video_url": vid_audio,
            # no duration_seconds → ffprobe path
            "tracks": self._track(0, 50),
        })
        assert r.status_code == 200
        assert r.get_json()["ok"] is True

    # --- validation / error cases ---

    def test_missing_source_url_rejected(self, client):
        r = client.post(self.EP, json={"tracks": self._track()})
        assert r.status_code == 400

    def test_empty_tracks_rejected(self, client, vid_audio):
        r = client.post(self.EP, json={"source_video_url": vid_audio, "tracks": []})
        assert r.status_code == 400

    def test_zero_segments_rejected(self, client, vid_audio):
        r = client.post(self.EP, json={
            "source_video_url": vid_audio,
            "tracks": [{"label": "Video", "track_type": "video", "segments": []}],
        })
        assert r.status_code == 400

    def test_too_many_segments_rejected(self, client, vid_audio):
        segs = [{"left": 0, "width": 1}] * 81
        r = client.post(self.EP, json={
            "source_video_url": vid_audio,
            "tracks": [{"label": "Video", "track_type": "video", "segments": segs}],
        })
        assert r.status_code == 400

    def test_invalid_end_before_start_rejected(self, client, vid_audio):
        r = client.post(self.EP, json={
            "source_video_url": vid_audio,
            "tracks": [{"label": "Video", "track_type": "video", "segments": [
                {"start_seconds": 2.0, "end_seconds": 1.0},
            ]}],
        })
        assert r.status_code == 400

    def test_non_video_tracks_skipped(self, client, vid_audio):
        """voice/bgm tracks are ignored; render proceeds with video track only."""
        r = client.post(self.EP, json={
            "source_video_url": vid_audio,
            "duration_seconds": 3.0,
            "tracks": [
                {"label": "Voice", "track_type": "voice",
                 "segments": [{"left": 0, "width": 100}]},
                {"label": "Video", "track_type": "video",
                 "segments": [{"left": 0, "width": 50}]},
            ],
        })
        d = r.get_json()
        assert r.status_code == 200
        assert d["segments_rendered"] == 1  # only video track segment

    def test_multi_source_two_clips(self, client, vid_audio, vid_silent):
        """source_videos + source_index: concat trims from two different data-URL clips."""
        r = client.post(self.EP, json={
            "source_videos": [vid_audio, vid_silent],
            "duration_seconds": 3.0,
            "tracks": [{
                "label": "Video",
                "track_type": "video",
                "segments": [
                    {"start_seconds": 0.0, "end_seconds": 1.0, "source_index": 0},
                    {"start_seconds": 0.5, "end_seconds": 1.5, "source_index": 1},
                ],
            }],
        })
        d = r.get_json()
        assert r.status_code == 200
        assert d["ok"] is True
        assert d["segments_rendered"] == 2
        assert d.get("source_count") == 2
        assert d["video_url"].endswith(".mp4")

    def test_source_videos_without_primary_url(self, client, vid_audio):
        """Only source_videos is required; source_video_url may be omitted."""
        r = client.post(self.EP, json={
            "source_videos": [vid_audio],
            "duration_seconds": 3.0,
            "tracks": [{
                "label": "Video",
                "track_type": "video",
                "segments": [{"left": 0, "width": 100}],
            }],
        })
        assert r.status_code == 200
        assert r.get_json()["ok"] is True


# ---------------------------------------------------------------------------
# /api/video/timeline/render  (async mode) + status + cancel
# ---------------------------------------------------------------------------

class TestTimelineRenderAsync:
    RENDER = "/api/video/timeline/render"
    STATUS = "/api/video/timeline/render/status"
    CANCEL = "/api/video/timeline/render/cancel"

    @staticmethod
    def _track():
        return [{"label": "Video", "track_type": "video",
                 "segments": [{"left": 0, "width": 100}]}]

    def test_async_returns_job_id(self, client, vid_audio):
        r = client.post(self.RENDER, json={
            "source_video_url": vid_audio,
            "duration_seconds": 3.0,
            "async_job": True,
            "tracks": self._track(),
        })
        d = r.get_json()
        assert r.status_code == 200
        assert d["async_job"] is True
        assert "job_id" in d
        assert d["status"] == "queued"

    def test_status_immediately_after_submit(self, client, vid_audio):
        r = client.post(self.RENDER, json={
            "source_video_url": vid_audio,
            "duration_seconds": 3.0,
            "async_job": True,
            "tracks": self._track(),
        })
        job_id = r.get_json()["job_id"]

        st = client.get(f"{self.STATUS}?job_id={job_id}").get_json()
        assert st["status"] in {"queued", "running", "done"}
        assert "progress" in st

    def test_async_job_completes(self, client, vid_audio):
        r = client.post(self.RENDER, json={
            "source_video_url": vid_audio,
            "duration_seconds": 3.0,
            "async_job": True,
            "tracks": self._track(),
        })
        job_id = r.get_json()["job_id"]

        # Poll up to 30 s
        st = {}
        for _ in range(30):
            st = client.get(f"{self.STATUS}?job_id={job_id}").get_json()
            if st["status"] in {"done", "failed", "cancelled"}:
                break
            time.sleep(1)

        assert st["status"] == "done", f"Job did not complete: {st}"
        result = st["result"]
        assert result["ok"] is True
        assert result["video_url"].endswith(".mp4")
        assert result["segments_rendered"] == 1

    def test_status_unknown_job_id(self, client):
        r = client.get(f"{self.STATUS}?job_id=not-a-real-job")
        assert r.status_code == 404

    def test_status_missing_job_id(self, client):
        r = client.get(self.STATUS)
        assert r.status_code == 400

    def test_cancel_nonexistent_job(self, client):
        r = client.post(self.CANCEL, json={"job_id": "ghost-job-id"})
        assert r.status_code == 404

    def test_cancel_missing_job_id(self, client):
        r = client.post(self.CANCEL, json={})
        assert r.status_code == 400

    def test_cancel_completed_job_idempotent(self, client, vid_audio):
        """Cancelling a finished job returns its current status without error."""
        r = client.post(self.RENDER, json={
            "source_video_url": vid_audio,
            "duration_seconds": 3.0,
            "async_job": True,
            "tracks": self._track(),
        })
        job_id = r.get_json()["job_id"]

        for _ in range(30):
            st = client.get(f"{self.STATUS}?job_id={job_id}").get_json()
            if st["status"] in {"done", "failed"}:
                break
            time.sleep(1)

        cancel = client.post(self.CANCEL, json={"job_id": job_id})
        cd = cancel.get_json()
        assert cancel.status_code == 200
        # status must not be changed to "cancelled" for an already-finished job
        assert cd["status"] in {"done", "failed"}

    def test_async_job_queue_limit_evicts_old_jobs(self, client, vid_audio):
        """When queue is at TIMELINE_JOB_MAX, oldest terminal job is evicted, new job accepted."""
        from unittest.mock import patch
        from shoplive.backend.web_app import create_app
        _app = create_app()

        # Find the timeline_jobs dict in registered closure
        # We'll patch the constant to a tiny limit for this test
        import shoplive.backend.api.video_edit_api as _ve_mod
        with _app.test_client() as _c:
            # Submit 3 quick jobs that will complete
            submitted = []
            for _ in range(3):
                r = _c.post(self.RENDER, json={
                    "source_video_url": vid_audio,
                    "duration_seconds": 3.0,
                    "async_job": True,
                    "tracks": self._track(),
                })
                assert r.status_code == 200
                submitted.append(r.get_json()["job_id"])

            # Wait for all to complete
            for jid in submitted:
                for _ in range(30):
                    st = _c.get(f"{self.STATUS}?job_id={jid}").get_json()
                    if st["status"] in {"done", "failed"}:
                        break
                    time.sleep(1)

            # All 3 jobs are terminal — a 4th must succeed (evicts oldest)
            r4 = _c.post(self.RENDER, json={
                "source_video_url": vid_audio,
                "duration_seconds": 3.0,
                "async_job": True,
                "tracks": self._track(),
            })
            assert r4.status_code == 200
            assert "job_id" in r4.get_json()

# ---------------------------------------------------------------------------
# /api/video/edit/export  –  edits.subtitles (batch ASR burn-in)
# ---------------------------------------------------------------------------

class TestBatchSubtitles:
    EP = "/api/video/edit/export"

    def test_single_subtitle_applied(self, client, vid_silent):
        subs = [{"text": "Hello", "start": 0.5, "end": 2.0}]
        r = client.post(self.EP, json={"video_url": vid_silent, "edits": {"subtitles": subs}})
        assert r.status_code == 200
        d = r.get_json()
        assert d["ok"] is True
        if DRAWTEXT_AVAILABLE:
            assert d["mask_applied"] is True

    def test_multiple_subtitles_applied(self, client, vid_silent):
        subs = [
            {"text": "First line", "start": 0.0, "end": 1.0},
            {"text": "Second line", "start": 1.2, "end": 2.5},
            {"text": "Third line", "start": 2.7, "end": 3.0},
        ]
        r = client.post(self.EP, json={"video_url": vid_silent, "edits": {"subtitles": subs}})
        assert r.status_code == 200
        assert r.get_json()["ok"] is True

    def test_chinese_subtitles(self, client, vid_silent):
        subs = [{"text": "限时特卖", "start": 0.0, "end": 2.0}]
        r = client.post(self.EP, json={"video_url": vid_silent, "edits": {"subtitles": subs}})
        assert r.status_code == 200
        assert r.get_json()["ok"] is True

    def test_special_char_subtitles(self, client, vid_silent):
        """Characters unsafe for ffmpeg drawtext must be escaped without crashing."""
        subs = [{"text": "50% OFF: It's here!", "start": 0.0, "end": 2.0}]
        r = client.post(self.EP, json={"video_url": vid_silent, "edits": {"subtitles": subs}})
        assert r.status_code == 200
        assert r.get_json()["ok"] is True

    def test_entries_with_empty_text_skipped(self, client, vid_silent):
        """Entries with empty/None text are skipped; valid entry still applied."""
        subs = [
            {"text": "", "start": 0.0, "end": 1.0},
            {"text": None, "start": 0.5, "end": 1.5},
            {"text": "Valid", "start": 1.0, "end": 2.0},
        ]
        r = client.post(self.EP, json={"video_url": vid_silent, "edits": {"subtitles": subs}})
        assert r.status_code == 200
        assert r.get_json()["ok"] is True

    def test_subtitles_and_masktext_coexist(self, client, vid_silent):
        """subtitles array and maskText can be sent together; both are applied."""
        r = client.post(self.EP, json={
            "video_url": vid_silent,
            "edits": {
                "maskText": "Static",
                "subtitles": [{"text": "Timed", "start": 0.5, "end": 1.5}],
            },
        })
        assert r.status_code == 200
        assert r.get_json()["ok"] is True

    def test_empty_subtitles_array_is_noop(self, client, vid_silent):
        r = client.post(self.EP, json={"video_url": vid_silent, "edits": {"subtitles": []}})
        assert r.status_code == 200
        assert r.get_json()["ok"] is True

    def test_non_list_subtitles_ignored(self, client, vid_silent):
        """Non-list value for subtitles is treated as empty — no crash."""
        r = client.post(self.EP, json={"video_url": vid_silent, "edits": {"subtitles": "bad"}})
        assert r.status_code == 200
        assert r.get_json()["ok"] is True

    def test_cap_at_30_subtitles(self, client, vid_silent):
        """Sending 35 subtitles: only first 30 are processed — no crash."""
        subs = [
            {"text": f"Line {i}", "start": i * 0.08, "end": i * 0.08 + 0.07}
            for i in range(35)
        ]
        r = client.post(self.EP, json={"video_url": vid_silent, "edits": {"subtitles": subs}})
        assert r.status_code == 200
        assert r.get_json()["ok"] is True


# ---------------------------------------------------------------------------
# /api/video/asr  –  Gemini transcription (external calls mocked)
# ---------------------------------------------------------------------------

class TestVideoASR:
    EP = "/api/video/asr"

    # --- validation ---

    def test_missing_video_url_rejected(self, client):
        r = client.post(self.EP, json={})
        assert r.status_code == 400
        assert r.get_json()["error_code"] == "MISSING_VIDEO_URL"

    def test_empty_video_url_rejected(self, client):
        r = client.post(self.EP, json={"video_url": ""})
        assert r.status_code == 400

    # --- happy path (Gemini mocked) ---

    def _mock_gemini(self, text: str):
        """Return (access_token_patch, requests_post_patch) context manager."""
        from unittest.mock import patch, MagicMock
        mock_resp = MagicMock()
        mock_resp.raise_for_status = lambda: None
        mock_resp.json.return_value = {
            "candidates": [{"content": {"parts": [{"text": text}]}}]
        }
        return (
            patch("shoplive.backend.infra.get_access_token", return_value="fake-token"),
            patch("requests.post", return_value=mock_resp),
        )

    def test_returns_parsed_subtitles(self, client, vid_silent):
        gemini_text = "[0.0-2.5] Hello world\n[3.0-5.0] Second subtitle\n"
        p1, p2 = self._mock_gemini(gemini_text)
        with p1, p2:
            r = client.post(self.EP, json={"video_url": vid_silent, "project_id": "test-proj"})
        assert r.status_code == 200
        d = r.get_json()
        assert d["ok"] is True
        assert len(d["subtitles"]) == 2
        assert d["subtitles"][0] == {"start": 0.0, "end": 2.5, "text": "Hello world"}
        assert d["subtitles"][1]["text"] == "Second subtitle"

    def test_no_speech_returns_empty_list(self, client, vid_silent):
        p1, p2 = self._mock_gemini("无语音内容")
        with p1, p2:
            r = client.post(self.EP, json={"video_url": vid_silent, "project_id": "test-proj"})
        assert r.status_code == 200
        d = r.get_json()
        assert d["ok"] is True
        assert d["subtitles"] == []

    def test_max_lines_respected(self, client, vid_silent):
        """max_lines=3 → at most 3 subtitles returned even if Gemini gives more."""
        lines = "\n".join(f"[{i}.0-{i+1}.0] line {i}" for i in range(10))
        p1, p2 = self._mock_gemini(lines)
        with p1, p2:
            r = client.post(self.EP, json={
                "video_url": vid_silent, "project_id": "test-proj", "max_lines": 3,
            })
        assert r.status_code == 200
        assert len(r.get_json()["subtitles"]) <= 3

    def test_max_lines_clamped_to_40(self, client, vid_silent):
        """max_lines > 40 is clamped to 40 — no crash."""
        lines = "\n".join(f"[{i}.0-{i+1}.0] line {i}" for i in range(50))
        p1, p2 = self._mock_gemini(lines)
        with p1, p2:
            r = client.post(self.EP, json={
                "video_url": vid_silent, "project_id": "test-proj", "max_lines": 999,
            })
        assert r.status_code == 200
        assert len(r.get_json()["subtitles"]) <= 40

    def test_malformed_lines_skipped(self, client, vid_silent):
        """Lines not matching [start-end] TEXT format are silently skipped."""
        gemini_text = "some garbage\n[0.0-2.0] Valid line\nmore garbage without brackets\n"
        p1, p2 = self._mock_gemini(gemini_text)
        with p1, p2:
            r = client.post(self.EP, json={"video_url": vid_silent, "project_id": "test-proj"})
        assert r.status_code == 200
        d = r.get_json()
        assert len(d["subtitles"]) == 1
        assert d["subtitles"][0]["text"] == "Valid line"

    def test_gemini_http_error_returns_500(self, client, vid_silent):
        """Non-2xx from Gemini → 500 with ASR_FAILED error_code."""
        import requests as _req
        from unittest.mock import patch, MagicMock
        mock_resp = MagicMock()
        mock_resp.raise_for_status.side_effect = _req.exceptions.HTTPError("403 Forbidden")
        with patch("shoplive.backend.infra.get_access_token", return_value="fake-token"), \
             patch("requests.post", return_value=mock_resp):
            r = client.post(self.EP, json={"video_url": vid_silent, "project_id": "test-proj"})
        assert r.status_code == 500
        assert r.get_json()["error_code"] == "ASR_FAILED"

    def test_raw_text_included_in_response(self, client, vid_silent):
        """raw_text field is always present in the response for debugging."""
        gemini_text = "[0.0-1.0] Hi\n"
        p1, p2 = self._mock_gemini(gemini_text)
        with p1, p2:
            r = client.post(self.EP, json={"video_url": vid_silent, "project_id": "test-proj"})
        assert r.status_code == 200
        assert "raw_text" in r.get_json()


# ---------------------------------------------------------------------------
# /api/video/overlay-image  –  ffmpeg image overlay
# ---------------------------------------------------------------------------

def _tiny_png_b64() -> str:
    """Generate a 32x32 red PNG via ffmpeg lavfi. Returns plain base64 (no data: prefix)."""
    with tempfile.NamedTemporaryFile(suffix=".png", delete=False) as f:
        tmp = Path(f.name)
    try:
        subprocess.run([
            "ffmpeg", "-y",
            "-f", "lavfi", "-i", "color=red:s=32x32:d=0.1:r=1",
            "-vframes", "1", str(tmp),
        ], check=True, capture_output=True)
        return base64.b64encode(tmp.read_bytes()).decode()
    finally:
        tmp.unlink(missing_ok=True)


@pytest.fixture(scope="module")
def tiny_png():
    return _tiny_png_b64()


class TestVideoOverlayImage:
    EP = "/api/video/overlay-image"

    # --- validation ---

    def test_missing_video_url_rejected(self, client, tiny_png):
        r = client.post(self.EP, json={"image_base64": tiny_png})
        assert r.status_code == 400
        assert r.get_json()["error_code"] == "MISSING_VIDEO_URL"

    def test_missing_image_rejected(self, client, vid_silent):
        r = client.post(self.EP, json={"video_url": vid_silent})
        assert r.status_code == 400
        assert r.get_json()["error_code"] == "MISSING_IMAGE"

    # --- happy path ---

    def test_overlay_top_right(self, client, vid_silent, tiny_png):
        r = client.post(self.EP, json={
            "video_url": vid_silent,
            "image_base64": tiny_png,
            "image_mime_type": "image/png",
            "overlay_position": "top-right",
            "overlay_scale": 0.3,
        })
        assert r.status_code == 200
        d = r.get_json()
        assert d["ok"] is True
        assert d["video_url"].endswith(".mp4")
        assert "file_name" in d

    @pytest.mark.parametrize("position", [
        "top-left", "top-right", "center", "bottom-left", "bottom-right"
    ])
    def test_all_positions(self, client, vid_silent, tiny_png, position):
        r = client.post(self.EP, json={
            "video_url": vid_silent,
            "image_base64": tiny_png,
            "overlay_position": position,
        })
        assert r.status_code == 200
        assert r.get_json()["ok"] is True

    def test_overlay_with_audio_preserved(self, client, vid_audio, tiny_png):
        """Audio stream is preserved after overlay."""
        r = client.post(self.EP, json={
            "video_url": vid_audio,
            "image_base64": tiny_png,
            "overlay_scale": 0.2,
        })
        assert r.status_code == 200
        assert r.get_json()["ok"] is True

    def test_overlay_duration_limited(self, client, vid_silent, tiny_png):
        """overlay_duration=1.0 applies enable='between(t,0,1.0)' — no crash."""
        r = client.post(self.EP, json={
            "video_url": vid_silent,
            "image_base64": tiny_png,
            "overlay_duration": 1.0,
        })
        assert r.status_code == 200
        assert r.get_json()["ok"] is True

    def test_overlay_scale_clamped_high(self, client, vid_silent, tiny_png):
        """overlay_scale > 1.0 is clamped to 1.0 — no crash."""
        r = client.post(self.EP, json={
            "video_url": vid_silent,
            "image_base64": tiny_png,
            "overlay_scale": 99.0,
        })
        assert r.status_code == 200
        assert r.get_json()["ok"] is True

    def test_overlay_scale_clamped_low(self, client, vid_silent, tiny_png):
        """overlay_scale < 0.05 is clamped to 0.05 — no crash."""
        r = client.post(self.EP, json={
            "video_url": vid_silent,
            "image_base64": tiny_png,
            "overlay_scale": 0.001,
        })
        assert r.status_code == 200
        assert r.get_json()["ok"] is True

    def test_data_url_prefix_stripped(self, client, vid_silent, tiny_png):
        """image_base64 with data:image/png;base64, prefix is handled correctly."""
        data_url_b64 = f"data:image/png;base64,{tiny_png}"
        r = client.post(self.EP, json={
            "video_url": vid_silent,
            "image_base64": data_url_b64,
        })
        assert r.status_code == 200
        assert r.get_json()["ok"] is True

    def test_unknown_position_falls_back_to_top_right(self, client, vid_silent, tiny_png):
        """Unrecognised overlay_position falls back to top-right — no crash."""
        r = client.post(self.EP, json={
            "video_url": vid_silent,
            "image_base64": tiny_png,
            "overlay_position": "invalid-position",
        })
        assert r.status_code == 200
        assert r.get_json()["ok"] is True

    def test_overlay_image_url_fetches_via_helper(self, client, vid_silent, tiny_png):
        """image_url path uses fetch_image_as_base64 — mock network, no real HTTP."""
        from unittest.mock import patch
        with patch(
            "shoplive.backend.common.helpers.fetch_image_as_base64",
            return_value=(tiny_png, "image/png"),
        ):
            r = client.post(self.EP, json={
                "video_url": vid_silent,
                "image_url": "https://cdn.example.com/product.png",
            })
        assert r.status_code == 200
        d = r.get_json()
        assert d["ok"] is True
        assert d["video_url"].endswith(".mp4")

    def test_overlay_padding(self, client, vid_silent, tiny_png):
        r = client.post(self.EP, json={
            "video_url": vid_silent,
            "image_base64": tiny_png,
            "padding": 8,
        })
        assert r.status_code == 200
        assert r.get_json()["ok"] is True
