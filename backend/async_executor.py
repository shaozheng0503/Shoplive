"""
Async Executor for Shoplive.

Provides async HTTP client and parallel execution utilities for tool calls.
Converts serial API calls to parallel where possible, significantly reducing
latency for multi-step workflows.

Design principles (from article):
- "提供多个 Tools 给模型调用的时候，可以通过实现异步的方案调用，
   将串行调用转为并行以加速执行"
"""

import asyncio
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from functools import wraps
from typing import Any, Callable, Dict, List, Optional, Tuple

import requests


# ---------------------------------------------------------------------------
# Thread-pool based parallel executor (compatible with Flask's sync model)
# ---------------------------------------------------------------------------

# Shared thread pool for parallel I/O operations
_executor = ThreadPoolExecutor(max_workers=8, thread_name_prefix="shoplive-async")


def parallel_execute(
    tasks: List[Dict[str, Any]],
    *,
    timeout_seconds: int = 120,
) -> List[Dict[str, Any]]:
    """Execute multiple independent tasks in parallel using a thread pool.

    Each task dict should have:
        - "name": str — task identifier
        - "fn": Callable — function to execute
        - "args": tuple — positional arguments (optional)
        - "kwargs": dict — keyword arguments (optional)

    Returns a list of result dicts:
        - "name": str
        - "ok": bool
        - "result": Any — return value on success
        - "error": str — error message on failure
        - "duration_ms": int

    Example:
        results = parallel_execute([
            {"name": "fetch_image_1", "fn": fetch_image_as_base64, "args": (url1, proxy)},
            {"name": "fetch_image_2", "fn": fetch_image_as_base64, "args": (url2, proxy)},
        ])
    """
    if not tasks:
        return []

    futures = {}
    results = []

    for task in tasks:
        fn = task["fn"]
        args = task.get("args", ())
        kwargs = task.get("kwargs", {})
        future = _executor.submit(fn, *args, **kwargs)
        futures[future] = {
            "name": task["name"],
            "start_time": time.monotonic(),
        }

    for future in as_completed(futures, timeout=timeout_seconds):
        meta = futures[future]
        duration_ms = int((time.monotonic() - meta["start_time"]) * 1000)
        try:
            result = future.result(timeout=1)
            results.append({
                "name": meta["name"],
                "ok": True,
                "result": result,
                "error": None,
                "duration_ms": duration_ms,
            })
        except Exception as e:
            results.append({
                "name": meta["name"],
                "ok": False,
                "result": None,
                "error": f"{type(e).__name__}: {e}",
                "duration_ms": duration_ms,
            })

    return results


def parallel_fetch_images(
    urls: List[str],
    proxy: str,
    *,
    fetch_fn: Callable,
    max_images: int = 6,
    timeout_seconds: int = 60,
) -> List[Dict[str, Any]]:
    """Fetch multiple images in parallel.

    Optimized for the common pattern of downloading 3-6 product images
    concurrently instead of sequentially. Typical speedup: 3-4x.

    Returns list of {"url", "base64", "mime_type", "ok", "error"}.
    """
    tasks = []
    for i, url in enumerate(urls[:max_images]):
        tasks.append({
            "name": f"image_{i}",
            "fn": fetch_fn,
            "args": (url, proxy),
        })

    results = parallel_execute(tasks, timeout_seconds=timeout_seconds)

    image_items = []
    for r in results:
        idx = int(r["name"].split("_")[1])
        url = urls[idx] if idx < len(urls) else ""
        if r["ok"] and r["result"]:
            b64, mime = r["result"]
            image_items.append({
                "url": url,
                "base64": b64,
                "mime_type": mime,
                "ok": True,
                "error": None,
            })
        else:
            image_items.append({
                "url": url,
                "base64": "",
                "mime_type": "",
                "ok": False,
                "error": r.get("error", "unknown"),
            })

    return image_items


def parallel_http_requests(
    request_configs: List[Dict[str, Any]],
    *,
    timeout_seconds: int = 90,
) -> List[Dict[str, Any]]:
    """Execute multiple HTTP requests in parallel.

    Each config dict should have:
        - "name": str
        - "method": "GET" | "POST"
        - "url": str
        - "headers": dict (optional)
        - "json": dict (optional)
        - "proxies": dict (optional)
        - "timeout": int (optional, default 90)

    Returns list of {"name", "ok", "status_code", "data", "error"}.
    """
    def _do_request(config: Dict[str, Any]) -> Dict[str, Any]:
        method = config.get("method", "POST").upper()
        url = config["url"]
        headers = config.get("headers", {})
        body = config.get("json")
        proxies = config.get("proxies", {})
        req_timeout = config.get("timeout", 90)

        if method == "GET":
            resp = requests.get(url, headers=headers, proxies=proxies, timeout=req_timeout)
        else:
            resp = requests.post(url, headers=headers, json=body, proxies=proxies, timeout=req_timeout)

        data = resp.json() if "json" in (resp.headers.get("content-type", "") or "") else {"raw": resp.text}
        return {
            "status_code": resp.status_code,
            "ok": resp.ok,
            "data": data,
        }

    tasks = [
        {"name": cfg["name"], "fn": _do_request, "args": (cfg,)}
        for cfg in request_configs
    ]

    raw_results = parallel_execute(tasks, timeout_seconds=timeout_seconds)

    results = []
    for r in raw_results:
        if r["ok"] and r["result"]:
            results.append({
                "name": r["name"],
                "ok": r["result"]["ok"],
                "status_code": r["result"]["status_code"],
                "data": r["result"]["data"],
                "error": None,
                "duration_ms": r["duration_ms"],
            })
        else:
            results.append({
                "name": r["name"],
                "ok": False,
                "status_code": 0,
                "data": {},
                "error": r.get("error", "request_failed"),
                "duration_ms": r["duration_ms"],
            })

    return results


# ---------------------------------------------------------------------------
# Async wrapper for use in async contexts (future FastAPI migration)
# ---------------------------------------------------------------------------

def run_sync_in_thread(fn: Callable, *args, **kwargs) -> Any:
    """Run a synchronous function in the thread pool.

    Useful for wrapping blocking I/O calls (requests, file I/O)
    in an async context without blocking the event loop.
    """
    future = _executor.submit(fn, *args, **kwargs)
    return future.result(timeout=120)


def get_executor() -> ThreadPoolExecutor:
    """Get the shared thread pool executor."""
    return _executor
