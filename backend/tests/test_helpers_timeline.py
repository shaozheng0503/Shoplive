import pytest

from shoplive.backend.common.helpers import normalize_timeline_video_segments


class TestNormalizeTimelineVideoSegments:
    def test_normalize_percent_segments(self):
        tracks = [
            {
                "label": "Video",
                "track_type": "video",
                "segments": [
                    {"left": 0, "width": 20},
                    {"left": 20, "width": 30},
                ],
            }
        ]
        out = normalize_timeline_video_segments(tracks, 10)
        assert [x["start"] for x in out] == [0.0, 2.0]
        assert [x["end"] for x in out] == [2.0, 5.0]

    def test_normalize_seconds_segments(self):
        tracks = [
            {
                "track_type": "video",
                "segments": [
                    {"start_seconds": 1.5, "end_seconds": 3.25},
                ],
            }
        ]
        out = normalize_timeline_video_segments(tracks, 8)
        assert out[0]["start"] == 1.5
        assert out[0]["end"] == 3.25

    def test_skip_non_video_track(self):
        tracks = [
            {"track_type": "voice", "segments": [{"left": 0, "width": 100}]},
            {"track_type": "video", "segments": [{"left": 10, "width": 10}]},
        ]
        out = normalize_timeline_video_segments(tracks, 10)
        assert len(out) == 1
        assert out[0]["start"] == 1.0
        assert out[0]["end"] == 2.0

    def test_filter_too_short_segment(self):
        tracks = [{"track_type": "video", "segments": [{"start_seconds": 1.0, "end_seconds": 1.01}]}]
        out = normalize_timeline_video_segments(tracks, 8, min_seconds=0.05)
        assert out == []

    def test_invalid_duration_rejected(self):
        with pytest.raises(ValueError):
            normalize_timeline_video_segments([], 0)

    def test_too_many_segments_rejected(self):
        tracks = [{"track_type": "video", "segments": [{"left": 0, "width": 100}] * 81}]
        with pytest.raises(ValueError):
            normalize_timeline_video_segments(tracks, 10, max_segments=80)

    def test_skip_disabled_track(self):
        tracks = [
            {"track_type": "video", "enabled": False, "segments": [{"left": 0, "width": 50}]},
            {"track_type": "video", "enabled": True, "segments": [{"left": 50, "width": 50}]},
        ]
        out = normalize_timeline_video_segments(tracks, 10)
        assert len(out) == 1
        assert out[0]["start"] == 5.0

    def test_sort_strategy_start_then_track(self):
        tracks = [
            {"track_type": "video", "order": 10, "segments": [{"left": 60, "width": 20}]},
            {"track_type": "video", "order": 0, "segments": [{"left": 10, "width": 20}]},
        ]
        out = normalize_timeline_video_segments(tracks, 10, sort_strategy="start_then_track")
        assert out[0]["start"] == 1.0
        assert out[1]["start"] == 6.0
