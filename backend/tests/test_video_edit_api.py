"""
Integration tests for video editing endpoints.

Tests run against a real Flask test client using ffmpeg-generated synthetic
videos — no external API calls (GCP, LiteLLM) are made.

Covered endpoints:
  POST /api/video/edit/export          – colour grading, speed, text, BGM
  POST /api/video/timeline/render      – segment clip & concat (sync + async)
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
