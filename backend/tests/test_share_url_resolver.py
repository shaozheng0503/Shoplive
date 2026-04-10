from types import SimpleNamespace


def _resp(url, text="", content_type="text/html; charset=utf-8"):
    return SimpleNamespace(
        url=url,
        text=text,
        headers={"Content-Type": content_type},
        raise_for_status=lambda: None,
    )


class TestShareUrlResolver:
    def test_direct_video_url_passthrough(self):
        from shoplive.backend.share_url_resolver import resolve_video_share_url

        result = resolve_video_share_url("https://cdn.example.com/sample.mp4")
        assert result["resolved_video_url"] == "https://cdn.example.com/sample.mp4"
        assert result["strategy"] == "direct"
        assert result["is_share_link"] is False

    def test_extracts_douyin_play_addr_from_html(self, monkeypatch):
        from shoplive.backend import share_url_resolver as mod

        html = r'''
        <html><head></head><body>
        <script>window.__DATA__={"playAddr":"https:\/\/aweme.snssdk.com\/aweme\/v1\/play\/?video_id=12345&ratio=720p"};</script>
        </body></html>
        '''
        monkeypatch.setattr(mod.requests, "get", lambda *args, **kwargs: _resp("https://www.douyin.com/video/12345", html))

        result = mod.resolve_video_share_url("https://v.douyin.com/abc/")
        assert result["strategy"] == "html_extract"
        assert result["is_share_link"] is True
        assert result["resolved_video_url"].startswith("https://aweme.snssdk.com/aweme/v1/play/")

    def test_extracts_xiaohongshu_og_video(self, monkeypatch):
        from shoplive.backend import share_url_resolver as mod

        html = """
        <html><head>
        <meta property="og:video" content="//sns-video-bd.xhscdn.com/stream/demo.mp4" />
        </head><body></body></html>
        """
        monkeypatch.setattr(mod.requests, "get", lambda *args, **kwargs: _resp("https://www.xiaohongshu.com/explore/demo", html))

        result = mod.resolve_video_share_url("https://xhslink.com/demo")
        assert result["strategy"] == "html_extract"
        assert result["resolved_video_url"] == "https://sns-video-bd.xhscdn.com/stream/demo.mp4"
        assert result["is_share_link"] is True

    def test_unresolved_page_returns_final_page(self, monkeypatch):
        from shoplive.backend import share_url_resolver as mod

        monkeypatch.setattr(
            mod.requests,
            "get",
            lambda *args, **kwargs: _resp("https://www.xiaohongshu.com/explore/demo", "<html><body>no video</body></html>"),
        )

        result = mod.resolve_video_share_url("https://xhslink.com/demo")
        assert result["strategy"] == "unresolved_page"
        assert result["resolved_page_url"] == "https://www.xiaohongshu.com/explore/demo"
        assert result["resolved_video_url"] == "https://www.xiaohongshu.com/explore/demo"

    def test_rendered_html_extract_when_requests_html_has_no_video(self, monkeypatch):
        from shoplive.backend import share_url_resolver as mod

        monkeypatch.setattr(
            mod.requests,
            "get",
            lambda *args, **kwargs: _resp("https://www.douyin.com/video/123", "<html><body>no playable url</body></html>"),
        )

        rendered = SimpleNamespace(
            url="https://www.douyin.com/video/123",
            html='<script>window.__DATA__={"playAddr":"https:\\/\\/aweme.snssdk.com\\/aweme\\/v1\\/play\\/?video_id=play123&ratio=720p"};</script>',
        )
        result = mod.resolve_video_share_url(
            "https://v.douyin.com/abc/",
            render_html=lambda *_args, **_kwargs: rendered,
        )
        assert result["strategy"] == "rendered_html_extract"
        assert result["resolved_video_url"].startswith("https://aweme.snssdk.com/aweme/v1/play/")
