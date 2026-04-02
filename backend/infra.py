import logging
import os
import socket
import threading
import time
from concurrent.futures import TimeoutError as FutureTimeoutError
from functools import lru_cache
from pathlib import Path
from typing import Dict, List, Optional, Tuple

import requests
from google.auth.transport.requests import Request
from google.oauth2 import service_account

logger = logging.getLogger(__name__)


BACKEND_DIR = Path(__file__).resolve().parent
SHOPLIVE_DIR = BACKEND_DIR.parent
PROJECT_ROOT = SHOPLIVE_DIR.parent.resolve()
DEFAULT_KEY_FILE_CANDIDATES = [
    (SHOPLIVE_DIR / "credentials/qy-shoplazza-02-ai-compet-huangshaozheng-ba94de5ac3ab.json").resolve(),
    (SHOPLIVE_DIR / "backend/qy-shoplazza-02-ai-compet-huangshaozheng-ba94de5ac3ab.json").resolve(),
    (PROJECT_ROOT / "gemini调用/qy-shoplazza-02-ai-compet-huangshaozheng-ba94de5ac3ab.json").resolve(),
    (
        PROJECT_ROOT
        / "gemini调用/vertex_gemini_veo_examples/qy-shoplazza-02-ai-compet-huangshaozheng-ba94de5ac3ab.json"
    ).resolve(),
]

COMMON_LOCAL_PROXY_PORTS = [7890, 7897, 7898, 20171]


@lru_cache(maxsize=1)
def discover_local_http_proxy() -> str:
    for port in COMMON_LOCAL_PROXY_PORTS:
        try:
            with socket.create_connection(("127.0.0.1", port), timeout=0.25):
                return f"http://127.0.0.1:{port}"
        except OSError:
            continue
    return ""


def discover_local_http_proxies() -> List[str]:
    found: List[str] = []
    for port in COMMON_LOCAL_PROXY_PORTS:
        try:
            with socket.create_connection(("127.0.0.1", port), timeout=0.25):
                found.append(f"http://127.0.0.1:{port}")
        except OSError:
            continue
    return found


def build_proxies(proxy: str) -> Dict[str, str]:
    raw_proxy = (proxy or "").strip()
    if raw_proxy.lower() in {"auto", "system"}:
        raw_proxy = ""
    if raw_proxy:
        return {"http": raw_proxy, "https": raw_proxy}
    http_proxy = (os.getenv("HTTP_PROXY") or os.getenv("http_proxy") or "").strip()
    https_proxy = (os.getenv("HTTPS_PROXY") or os.getenv("https_proxy") or "").strip()
    result = {}
    if http_proxy:
        result["http"] = http_proxy
    if https_proxy:
        result["https"] = https_proxy
    if not result:
        local_proxy = discover_local_http_proxy()
        if local_proxy:
            result["http"] = local_proxy
            result["https"] = local_proxy
    return result


def build_proxy_candidates(proxy: str) -> List[Dict[str, str]]:
    candidates: List[Dict[str, str]] = []
    seen = set()

    def push(p: Dict[str, str]):
        key = (p.get("http", ""), p.get("https", ""))
        if key not in seen:
            seen.add(key)
            candidates.append(p)

    explicit = (proxy or "").strip()
    if explicit and explicit.lower() not in {"auto", "system"}:
        push({"http": explicit, "https": explicit})

    env_http = (os.getenv("HTTP_PROXY") or os.getenv("http_proxy") or "").strip()
    env_https = (os.getenv("HTTPS_PROXY") or os.getenv("https_proxy") or "").strip()
    env_proxy: Dict[str, str] = {}
    if env_http:
        env_proxy["http"] = env_http
    if env_https:
        env_proxy["https"] = env_https
    if env_proxy:
        push(env_proxy)

    for local_proxy in discover_local_http_proxies():
        push({"http": local_proxy, "https": local_proxy})

    push({})
    return candidates


# ---------------------------------------------------------------------------
# Dynamic Temporary Credentials (Article: "Secretless 动态临时凭证")
#
# Instead of loading the key file every time, we cache the credentials object
# and its short-lived token. Tokens auto-refresh when expired (typically 1h).
# This reduces disk I/O, speeds up auth, and aligns with "用完即失效" principle.
# ---------------------------------------------------------------------------

class _TokenCache:
    """Thread-safe short-lived token cache with auto-refresh.

    Implements the article's "Secretless" concept:
    - Tokens are cached and reused until near expiry
    - Auto-refresh on access when within TTL buffer
    - Thread-safe with lock protection
    - Metrics tracking for observability
    """

    def __init__(self, ttl_buffer_seconds: int = 120):
        self._lock = threading.Lock()
        self._cache: Dict[str, Dict] = {}  # key_file -> {creds, token, expiry, proxy}
        self._ttl_buffer = ttl_buffer_seconds
        self._stats = {"hits": 0, "misses": 0, "refreshes": 0}

    def get_token(self, key_file: str, proxy: str, timeout_seconds: int = 20) -> str:
        """Get a valid access token, using cache when possible."""
        cache_key = key_file
        now = time.time()

        with self._lock:
            cached = self._cache.get(cache_key)
            if cached and cached.get("token") and cached.get("expiry", 0) > now + self._ttl_buffer:
                self._stats["hits"] += 1
                return cached["token"]
            self._stats["misses"] += 1

        # Cache miss or expired — refresh
        token = self._refresh_token(key_file, proxy, timeout_seconds)

        with self._lock:
            self._cache[cache_key] = {
                "token": token,
                "expiry": now + 3500,  # Google tokens typically valid for 3600s
                "refreshed_at": now,
            }
            self._stats["refreshes"] += 1

        return token

    def _refresh_token(self, key_file: str, proxy: str, timeout_seconds: int) -> str:
        """Refresh the token using the original multi-proxy strategy."""
        return _get_access_token_raw(key_file, proxy, timeout_seconds)

    def invalidate(self, key_file: str):
        """Force-invalidate a cached token (e.g., on auth failure)."""
        with self._lock:
            self._cache.pop(key_file, None)

    def get_stats(self) -> Dict:
        """Return cache statistics for observability."""
        with self._lock:
            return dict(self._stats)


# Global token cache instance
_token_cache = _TokenCache()


def _get_access_token_raw(key_file: str, proxy: str, timeout_seconds: int = 20) -> str:
    """Raw token refresh without caching (original implementation)."""
    def _refresh(proxy_map: Dict[str, str]) -> str:
        creds = service_account.Credentials.from_service_account_file(
            key_file, scopes=["https://www.googleapis.com/auth/cloud-platform"]
        )
        sess = requests.Session()
        sess.trust_env = False
        auth_req = Request(session=sess)
        if proxy_map:
            auth_req.session.proxies.update(proxy_map)
        creds.refresh(auth_req)
        return creds.token

    from shoplive.backend.async_executor import get_executor

    errors: List[str] = []
    candidates = build_proxy_candidates(proxy)
    executor = get_executor()
    for idx, proxy_map in enumerate(candidates, start=1):
        tag = proxy_map.get("https") or proxy_map.get("http") or "DIRECT"
        future = executor.submit(_refresh, proxy_map)
        try:
            return future.result(timeout=timeout_seconds)
        except FutureTimeoutError:
            errors.append(f"[{idx}] {tag} -> timeout")
        except Exception as e:
            errors.append(f"[{idx}] {tag} -> {type(e).__name__}: {e}")
    raise TimeoutError(
        "获取访问令牌失败，已尝试多种代理策略: "
        + " | ".join(errors[:6])
    )


def get_access_token(key_file: str, proxy: str, timeout_seconds: int = 20) -> str:
    """Get an access token with automatic caching and refresh.

    Uses the TokenCache for performance:
    - Cached tokens reused until 2 minutes before expiry
    - Auto-refresh on cache miss
    - Thread-safe for concurrent requests
    """
    return _token_cache.get_token(key_file, proxy, timeout_seconds)


def invalidate_token_cache(key_file: str):
    """Force-invalidate a cached token on auth failure."""
    _token_cache.invalidate(key_file)


def get_token_cache_stats() -> Dict:
    """Return token cache statistics for observability."""
    return _token_cache.get_stats()


def parse_common_payload(payload: Dict) -> Tuple[str, str, str, str]:
    project_id = payload.get("project_id", "qy-shoplazza-02").strip()
    key_file = (payload.get("key_file") or os.getenv("GOOGLE_APPLICATION_CREDENTIALS") or "").strip()
    if key_file:
        key_path = Path(key_file).expanduser().resolve()
    else:
        key_path = next((p for p in DEFAULT_KEY_FILE_CANDIDATES if p.exists()), DEFAULT_KEY_FILE_CANDIDATES[0])
    key_file = str(key_path)
    proxy = payload.get("proxy", "").strip()
    if not project_id:
        raise ValueError("project_id 不能为空")
    if not key_path.exists():
        raise ValueError(f"key_file 不存在: {key_file}")
    return project_id, key_file, proxy, payload.get("model", "").strip()

