import os
import socket
from concurrent.futures import ThreadPoolExecutor, TimeoutError as FutureTimeoutError
from functools import lru_cache
from pathlib import Path
from typing import Dict, List, Tuple

import requests
from google.auth.transport.requests import Request
from google.oauth2 import service_account


BACKEND_DIR = Path(__file__).resolve().parent
SHOPLIVE_DIR = BACKEND_DIR.parent
PROJECT_ROOT = SHOPLIVE_DIR.parent.resolve()
DEFAULT_KEY_FILE_CANDIDATES = [
    (SHOPLIVE_DIR / "credentials/gemini-sl-20251120-gemini-video-hsz-82ee1e22902c.json").resolve(),
    (SHOPLIVE_DIR / "backend/gemini-sl-20251120-gemini-video-hsz-82ee1e22902c.json").resolve(),
    (PROJECT_ROOT / "gemini调用/gemini-sl-20251120-gemini-video-hsz-82ee1e22902c.json").resolve(),
    (
        PROJECT_ROOT
        / "gemini调用/vertex_gemini_veo_examples/gemini-sl-20251120-gemini-video-hsz-82ee1e22902c.json"
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


def get_access_token(key_file: str, proxy: str, timeout_seconds: int = 20) -> str:
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

    errors: List[str] = []
    candidates = build_proxy_candidates(proxy)
    for idx, proxy_map in enumerate(candidates, start=1):
        tag = proxy_map.get("https") or proxy_map.get("http") or "DIRECT"
        executor = ThreadPoolExecutor(max_workers=1)
        future = executor.submit(_refresh, proxy_map)
        try:
            return future.result(timeout=timeout_seconds)
        except FutureTimeoutError:
            errors.append(f"[{idx}] {tag} -> timeout")
        except Exception as e:
            errors.append(f"[{idx}] {tag} -> {type(e).__name__}: {e}")
        finally:
            executor.shutdown(wait=False, cancel_futures=True)
    raise TimeoutError(
        "获取访问令牌失败，已尝试多种代理策略: "
        + " | ".join(errors[:6])
    )


def parse_common_payload(payload: Dict) -> Tuple[str, str, str, str]:
    project_id = payload.get("project_id", "gemini-sl-20251120").strip()
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

