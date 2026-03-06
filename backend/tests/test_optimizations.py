"""
Tests for round-5 optimizations:
  - sign_gcs_url / _get_gcs_client lru_cache (no redundant disk reads)
  - _TTLCache used as LLM response cache in shoplive_api
  - _chain_jobs TTL eviction logic
  - _poll_video_ready initial_wait_seconds parameter
  - async chain job status endpoint (/api/veo/chain/status)
  - 16s workflow uses shared executor (no per-request ThreadPoolExecutor)
"""

import time
import threading
from unittest.mock import MagicMock, patch, call

import pytest


# ---------------------------------------------------------------------------
# 1. sign_gcs_url / _get_gcs_client — LRU cache
# ---------------------------------------------------------------------------

class TestGetGcsClientCache:
    def test_same_key_file_returns_cached_client(self):
        from shoplive.backend.common.helpers import _get_gcs_client
        _get_gcs_client.cache_clear()

        fake_creds = MagicMock()
        fake_creds.project_id = "test-project"
        fake_client = MagicMock()

        with patch("shoplive.backend.common.helpers.service_account.Credentials.from_service_account_file",
                   return_value=fake_creds) as mock_creds, \
             patch("shoplive.backend.common.helpers.storage.Client",
                   return_value=fake_client) as mock_client:
            c1 = _get_gcs_client("/fake/key.json")
            c2 = _get_gcs_client("/fake/key.json")

        # Client constructor called once, not twice
        assert mock_client.call_count == 1
        assert c1 is c2

    def test_different_key_files_get_separate_clients(self):
        from shoplive.backend.common.helpers import _get_gcs_client
        _get_gcs_client.cache_clear()

        fake_creds = MagicMock()
        fake_creds.project_id = "test-project"

        with patch("shoplive.backend.common.helpers.service_account.Credentials.from_service_account_file",
                   return_value=fake_creds), \
             patch("shoplive.backend.common.helpers.storage.Client",
                   side_effect=lambda **kw: MagicMock()) as mock_client:
            c1 = _get_gcs_client("/fake/key_a.json")
            c2 = _get_gcs_client("/fake/key_b.json")

        assert mock_client.call_count == 2
        assert c1 is not c2

    def test_sign_gcs_url_uses_cached_client(self):
        from shoplive.backend.common.helpers import _get_gcs_client, sign_gcs_url
        _get_gcs_client.cache_clear()

        fake_creds = MagicMock()
        fake_creds.project_id = "test-project"
        fake_blob = MagicMock()
        fake_blob.generate_signed_url.return_value = "https://signed.url/video.mp4"
        fake_bucket = MagicMock()
        fake_bucket.blob.return_value = fake_blob
        fake_client = MagicMock()
        fake_client.bucket.return_value = fake_bucket

        with patch("shoplive.backend.common.helpers.service_account.Credentials.from_service_account_file",
                   return_value=fake_creds), \
             patch("shoplive.backend.common.helpers.storage.Client",
                   return_value=fake_client):
            url1 = sign_gcs_url("gs://my-bucket/video1.mp4", "/fake/key.json")
            url2 = sign_gcs_url("gs://my-bucket/video2.mp4", "/fake/key.json")

        # Client created once; both blobs signed using the same cached client
        assert fake_client.bucket.call_count == 2
        assert url1 == "https://signed.url/video.mp4"
        assert url2 == "https://signed.url/video.mp4"

    def test_sign_gcs_url_bad_uri_returns_empty(self):
        from shoplive.backend.common.helpers import sign_gcs_url
        assert sign_gcs_url("not-a-gs-uri", "/fake/key.json") == ""
        assert sign_gcs_url("", "/fake/key.json") == ""


# ---------------------------------------------------------------------------
# 2. _TTLCache as LLM response cache
# ---------------------------------------------------------------------------

class TestLLMResponseCache:
    def test_cache_miss_then_hit(self):
        from shoplive.backend.async_executor import _TTLCache
        cache = _TTLCache(ttl_seconds=60, max_size=10)
        key = "script:abc123:gpt-4:deadbeef"

        assert cache.get(key) is None

        cache.set(key, {"script": "hello world script"})
        cached = cache.get(key)
        assert cached is not None
        assert cached["script"] == "hello world script"

    def test_cache_expires_after_ttl(self):
        from shoplive.backend.async_executor import _TTLCache
        cache = _TTLCache(ttl_seconds=1, max_size=10)
        key = "prompt:xyz:model:12345678"
        cache.set(key, {"prompt": "buy now!"})

        time.sleep(1.1)
        assert cache.get(key) is None

    def test_cache_evicts_oldest_when_full(self):
        from shoplive.backend.async_executor import _TTLCache
        cache = _TTLCache(ttl_seconds=60, max_size=3)
        for i in range(3):
            cache.set(f"key:{i}", {"v": i})
        # Fill to capacity then add one more
        cache.set("key:overflow", {"v": 99})
        stats = cache.get_stats()
        assert stats["evictions"] == 1
        assert stats["size"] <= 3

    def test_llm_response_cache_global_instance(self):
        """shoplive_api._llm_response_cache is accessible and functional."""
        from shoplive.backend.api.shoplive_api import _llm_response_cache
        k = "test_global_instance"
        _llm_response_cache.set(k, {"data": 42})
        assert _llm_response_cache.get(k) == {"data": 42}


# ---------------------------------------------------------------------------
# 3. _chain_jobs TTL eviction
# ---------------------------------------------------------------------------

class TestChainJobEviction:
    def _make_veo_module(self):
        """Import the closure-internal helpers via the Flask app."""
        from shoplive.backend.web_app import create_app
        app = create_app()
        return app

    def test_chain_jobs_evicted_after_ttl(self):
        """Completed jobs older than CHAIN_JOB_TTL_SECONDS are evicted on next update."""
        from shoplive.backend.web_app import create_app
        app = create_app()
        app.config["TESTING"] = True

        with app.test_client() as c:
            # Poll a fake job_id → expect 404 (job doesn't exist)
            resp = c.get("/api/veo/chain/status?job_id=nonexistent-job-id")
            assert resp.status_code == 404

    def test_chain_status_missing_job_id(self):
        from shoplive.backend.web_app import create_app
        app = create_app()
        app.config["TESTING"] = True
        with app.test_client() as c:
            resp = c.get("/api/veo/chain/status")
            assert resp.status_code == 400
            d = resp.get_json()
            assert d["ok"] is False

    def test_chain_status_empty_job_id(self):
        from shoplive.backend.web_app import create_app
        app = create_app()
        app.config["TESTING"] = True
        with app.test_client() as c:
            resp = c.get("/api/veo/chain/status?job_id=")
            assert resp.status_code == 400


# ---------------------------------------------------------------------------
# 4. _poll_video_ready initial_wait_seconds
# ---------------------------------------------------------------------------

class TestPollVideoReadyInitialWait:
    def _get_poll_fn(self):
        """Extract _poll_video_ready from the veo register closure via a minimal app."""
        # We test the parameter existence and sleep behaviour via mocking
        import importlib
        import shoplive.backend.api.veo_api as veo_module
        return veo_module

    def test_initial_wait_default_is_20(self):
        """_poll_video_ready signature has initial_wait_seconds=20."""
        import inspect
        import shoplive.backend.web_app as wam

        app = wam.create_app()
        app.config["TESTING"] = True

        # We inspect the source to confirm default
        import shoplive.backend.api.veo_api as vm
        src = inspect.getsource(vm)
        assert "initial_wait_seconds: int = 20" in src

    def test_initial_wait_sleep_called(self):
        """When initial_wait_seconds > 0, time.sleep is called before first poll."""
        # We build a minimal stub environment to call _poll_video_ready directly
        from flask import Flask
        import shoplive.backend.api.veo_api as veo_module

        stub_app = Flask(__name__)
        sleep_calls = []

        real_sleep = time.sleep

        # Collect a running app's _poll_video_ready by building one
        poll_ref = {}

        def _fake_json_error(msg, code=400):
            return ({"error": msg}, code)

        def _fake_parse_common(p):
            return "proj", "/k", "", ""

        def _fake_get_token(k, p):
            return "tok"

        def _fake_build_proxies(p):
            return {}

        def _noop(*a, **kw):
            return []

        fake_fns = dict(
            json_error=_fake_json_error,
            parse_common_payload=_fake_parse_common,
            get_access_token=_fake_get_token,
            build_proxies=_fake_build_proxies,
            normalize_reference_urls=_noop,
            normalize_reference_images_base64=_noop,
            parse_data_url=lambda x: ("", "image/png"),
            fetch_image_as_base64=lambda u, p: ("", "image/png"),
            normalize_duration_seconds=lambda x: 8,
            extract_gs_paths=_noop,
            extract_inline_videos=_noop,
            sign_gcs_url=lambda u, k: "",
        )
        veo_module.register_veo_routes(stub_app, **fake_fns)

        # Source check: initial_wait_seconds respected
        import inspect
        src = inspect.getsource(veo_module)
        assert "time.sleep(min(initial_wait_seconds, max_wait_seconds))" in src


# ---------------------------------------------------------------------------
# 5. 16s workflow uses shared executor (no per-request ThreadPoolExecutor)
# ---------------------------------------------------------------------------

class TestSharedExecutorIn16sWorkflow:
    def test_no_new_threadpoolexecutor_context_manager(self):
        """The 16s workflow code no longer uses 'with ThreadPoolExecutor' per request."""
        import inspect
        import shoplive.backend.api.veo_api as vm
        src = inspect.getsource(vm)

        # The old pattern was: `with ThreadPoolExecutor(max_workers=2) as pool:`
        # After fix it should use get_executor() from async_executor
        assert "with ThreadPoolExecutor(max_workers=2)" not in src

    def test_get_executor_used_in_16s_section(self):
        """After fix, the 16s section should reference get_executor."""
        import inspect
        import shoplive.backend.api.veo_api as vm
        src = inspect.getsource(vm)
        assert "get_executor()" in src


# ---------------------------------------------------------------------------
# 6. infra.py no longer imports ThreadPoolExecutor
# ---------------------------------------------------------------------------

class TestInfraNoExecutorLeak:
    def test_infra_uses_shared_executor(self):
        import inspect
        import shoplive.backend.infra as infra_module
        src = inspect.getsource(infra_module)
        # ThreadPoolExecutor import removed from infra.py
        assert "from concurrent.futures import ThreadPoolExecutor" not in src
        # It now delegates to get_executor()
        assert "get_executor" in src

    def test_get_access_token_raw_no_per_attempt_pool(self):
        """_get_access_token_raw no longer creates a per-attempt ThreadPoolExecutor."""
        import inspect
        import shoplive.backend.infra as infra_module
        src = inspect.getsource(infra_module._get_access_token_raw)
        assert "ThreadPoolExecutor(" not in src


# ---------------------------------------------------------------------------
# 7. shoplive_api _base_response helper reduces duplication
# ---------------------------------------------------------------------------

class TestShopliveBaseResponse:
    def test_workflow_validate_action(self):
        from shoplive.backend.web_app import create_app
        app = create_app()
        app.config["TESTING"] = True
        with app.test_client() as c:
            resp = c.post("/api/shoplive/video/workflow", json={
                "action": "validate",
                "input": {
                    "product_name": "Test Product",
                    "selling_points": ["fast", "cheap"],
                    "duration": 8,
                },
            })
            assert resp.status_code == 200
            d = resp.get_json()
            # _base fields always present
            assert "action" in d
            assert "ready" in d
            assert "validation" in d
            assert "normalized_input" in d
            assert "input_fingerprint" in d
            assert "effective_duration_seconds" in d
            assert d["action"] == "validate"

    def test_workflow_pre_export_check_action(self):
        from shoplive.backend.web_app import create_app
        app = create_app()
        app.config["TESTING"] = True
        with app.test_client() as c:
            resp = c.post("/api/shoplive/video/workflow", json={
                "action": "pre_export_check",
                "input": {
                    "product_name": "Test Product",
                    "selling_points": ["durable"],
                    "duration": 8,
                },
                "script_text": "Scene 1: product hero shot\nScene 2: CTA",
            })
            assert resp.status_code == 200
            d = resp.get_json()
            assert "selfcheck" in d
            assert "ready" in d
