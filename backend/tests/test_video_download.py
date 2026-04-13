from pathlib import Path


class _Resp:
    def __init__(self, *, headers=None, chunks=None, status_code=200):
        self.headers = headers or {}
        self._chunks = chunks or [b""]
        self.status_code = status_code

    def raise_for_status(self):
        if self.status_code >= 400:
            raise RuntimeError(f"HTTP {self.status_code}")

    def iter_content(self, chunk_size=1024):
        _ = chunk_size
        for chunk in self._chunks:
            yield chunk


def test_download_video_to_file_uses_browser_headers_for_douyin(monkeypatch, tmp_path):
    from shoplive.backend.common import helpers as mod

    calls = []

    def _fake_get(url, **kwargs):
        calls.append({"url": url, "kwargs": kwargs})
        if len(calls) == 1:
            raise ConnectionResetError("connection reset")
        return _Resp(
            headers={"Content-Length": "8", "Content-Type": "video/mp4"},
            chunks=[b"video", b"123"],
        )

    monkeypatch.setattr(mod.requests, "get", _fake_get)
    out = Path(tmp_path) / "video.mp4"
    mod.download_video_to_file(
        "https://aweme.snssdk.com/aweme/v1/playwm/?video_id=demo123",
        out,
        "",
    )

    assert out.read_bytes() == b"video123"
    assert len(calls) == 2
    assert calls[0]["kwargs"]["headers"]["User-Agent"]
    assert calls[0]["kwargs"]["headers"]["Referer"] == "https://www.iesdouyin.com/"
    assert calls[1]["kwargs"]["headers"]["Range"] == "bytes=0-"
    assert calls[1]["kwargs"]["allow_redirects"] is True


def test_download_video_to_file_uses_xiaohongshu_referer(monkeypatch, tmp_path):
    from shoplive.backend.common import helpers as mod

    captured = {}

    def _fake_get(url, **kwargs):
        captured["url"] = url
        captured["headers"] = kwargs.get("headers") or {}
        return _Resp(
            headers={"Content-Length": "4", "Content-Type": "video/mp4"},
            chunks=[b"demo"],
        )

    monkeypatch.setattr(mod.requests, "get", _fake_get)
    out = Path(tmp_path) / "xhs.mp4"
    mod.download_video_to_file("https://sns-video-bd.xhscdn.com/stream/demo.mp4", out, "")

    assert out.read_bytes() == b"demo"
    assert captured["headers"]["Referer"] == "https://www.xiaohongshu.com/"
