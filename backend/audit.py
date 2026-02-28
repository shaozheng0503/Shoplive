"""
Full-Chain Audit & Observability for Shoplive.

Records every tool call with structured context for tracing, debugging,
and compliance. Implements the article's "审计与可观测" principle:
- trace_id for end-to-end request tracing
- Structured logging for every tool invocation
- Call chain tracking across multi-step workflows
- Performance metrics and error classification
- Persistent audit log for post-mortem analysis

Usage:
    from shoplive.backend.audit import audit_log, start_trace, get_trace_id

    # In Flask before_request:
    start_trace()

    # In any tool/API:
    audit_log.record(
        tool="generate_video",
        action="veo_start",
        input_summary={"prompt_length": 200, "mode": "text"},
        output_summary={"operation_name": "xxx"},
        status="success",
    )
"""

import json
import logging
import os
import threading
import time
import uuid
from collections import deque
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Deque, Dict, List, Optional

logger = logging.getLogger("shoplive.audit")


# ---------------------------------------------------------------------------
# Trace Context (per-request)
# ---------------------------------------------------------------------------

_trace_local = threading.local()


def start_trace(trace_id: Optional[str] = None, user_id: str = "", session_id: str = ""):
    """Start a new trace for the current request thread."""
    _trace_local.trace_id = trace_id or uuid.uuid4().hex[:16]
    _trace_local.user_id = user_id
    _trace_local.session_id = session_id
    _trace_local.start_time = time.monotonic()
    _trace_local.call_chain = []


def get_trace_id() -> str:
    """Get the current trace ID."""
    return getattr(_trace_local, "trace_id", "no-trace")


def get_trace_context() -> Dict[str, Any]:
    """Get the full trace context for the current request."""
    return {
        "trace_id": getattr(_trace_local, "trace_id", "no-trace"),
        "user_id": getattr(_trace_local, "user_id", ""),
        "session_id": getattr(_trace_local, "session_id", ""),
        "call_chain": getattr(_trace_local, "call_chain", []),
        "elapsed_ms": int((time.monotonic() - getattr(_trace_local, "start_time", time.monotonic())) * 1000),
    }


def append_to_call_chain(tool_name: str, status: str, duration_ms: int):
    """Append a tool call to the current trace's call chain."""
    chain = getattr(_trace_local, "call_chain", [])
    chain.append({
        "tool": tool_name,
        "status": status,
        "duration_ms": duration_ms,
        "seq": len(chain) + 1,
    })
    _trace_local.call_chain = chain


# ---------------------------------------------------------------------------
# Audit Record
# ---------------------------------------------------------------------------

class AuditRecord:
    """A single audit log entry."""

    def __init__(
        self,
        *,
        tool: str,
        action: str,
        trace_id: str,
        input_summary: Dict[str, Any],
        output_summary: Dict[str, Any],
        status: str,  # "success", "error", "timeout", "validation_error"
        duration_ms: int,
        error_code: Optional[str] = None,
        error_message: Optional[str] = None,
        user_id: str = "",
        metadata: Optional[Dict[str, Any]] = None,
    ):
        self.timestamp = datetime.now(timezone.utc).isoformat()
        self.trace_id = trace_id
        self.tool = tool
        self.action = action
        self.input_summary = input_summary
        self.output_summary = output_summary
        self.status = status
        self.duration_ms = duration_ms
        self.error_code = error_code
        self.error_message = error_message
        self.user_id = user_id
        self.metadata = metadata or {}

    def to_dict(self) -> Dict[str, Any]:
        d = {
            "timestamp": self.timestamp,
            "trace_id": self.trace_id,
            "tool": self.tool,
            "action": self.action,
            "status": self.status,
            "duration_ms": self.duration_ms,
            "input_summary": self.input_summary,
            "output_summary": self.output_summary,
        }
        if self.error_code:
            d["error_code"] = self.error_code
        if self.error_message:
            d["error_message"] = self.error_message
        if self.user_id:
            d["user_id"] = self.user_id
        if self.metadata:
            d["metadata"] = self.metadata
        return d

    def to_json(self) -> str:
        return json.dumps(self.to_dict(), ensure_ascii=False)


# ---------------------------------------------------------------------------
# Audit Logger
# ---------------------------------------------------------------------------

class AuditLogger:
    """Structured audit logger with in-memory buffer and file persistence.

    Features:
    - In-memory ring buffer for recent records (fast query)
    - Optional file persistence (JSONL format)
    - Thread-safe operations
    - Aggregate statistics
    """

    def __init__(
        self,
        *,
        max_buffer_size: int = 1000,
        log_file: Optional[Path] = None,
    ):
        self._lock = threading.Lock()
        self._buffer: Deque[AuditRecord] = deque(maxlen=max_buffer_size)
        self._log_file = log_file
        self._stats = {
            "total_calls": 0,
            "success_count": 0,
            "error_count": 0,
            "total_duration_ms": 0,
            "tools": {},  # tool_name -> {"calls": N, "errors": N, "total_ms": N}
        }

        # Ensure log directory exists
        if self._log_file:
            self._log_file.parent.mkdir(parents=True, exist_ok=True)

    def record(
        self,
        *,
        tool: str,
        action: str,
        input_summary: Optional[Dict[str, Any]] = None,
        output_summary: Optional[Dict[str, Any]] = None,
        status: str = "success",
        duration_ms: int = 0,
        error_code: Optional[str] = None,
        error_message: Optional[str] = None,
        metadata: Optional[Dict[str, Any]] = None,
    ):
        """Record a tool call in the audit log."""
        trace_id = get_trace_id()
        user_id = getattr(_trace_local, "user_id", "")

        entry = AuditRecord(
            tool=tool,
            action=action,
            trace_id=trace_id,
            input_summary=input_summary or {},
            output_summary=output_summary or {},
            status=status,
            duration_ms=duration_ms,
            error_code=error_code,
            error_message=error_message,
            user_id=user_id,
            metadata=metadata,
        )

        # Update call chain
        append_to_call_chain(tool, status, duration_ms)

        with self._lock:
            self._buffer.append(entry)
            self._stats["total_calls"] += 1
            self._stats["total_duration_ms"] += duration_ms
            if status == "success":
                self._stats["success_count"] += 1
            else:
                self._stats["error_count"] += 1

            # Per-tool stats
            if tool not in self._stats["tools"]:
                self._stats["tools"][tool] = {"calls": 0, "errors": 0, "total_ms": 0}
            self._stats["tools"][tool]["calls"] += 1
            self._stats["tools"][tool]["total_ms"] += duration_ms
            if status != "success":
                self._stats["tools"][tool]["errors"] += 1

        # Log to file (non-blocking)
        if self._log_file:
            try:
                with open(self._log_file, "a", encoding="utf-8") as f:
                    f.write(entry.to_json() + "\n")
            except Exception as e:
                logger.warning(f"Audit log write failed: {e}")

        # Also log via standard logging
        log_fn = logger.info if status == "success" else logger.warning
        log_fn(
            f"[{trace_id}] {tool}.{action} -> {status} ({duration_ms}ms)",
            extra={"audit": entry.to_dict()},
        )

    def get_recent(self, limit: int = 50) -> List[Dict[str, Any]]:
        """Get recent audit records."""
        with self._lock:
            records = list(self._buffer)
        return [r.to_dict() for r in records[-limit:]]

    def get_trace(self, trace_id: str) -> List[Dict[str, Any]]:
        """Get all records for a specific trace."""
        with self._lock:
            records = [r for r in self._buffer if r.trace_id == trace_id]
        return [r.to_dict() for r in records]

    def get_stats(self) -> Dict[str, Any]:
        """Get aggregate statistics."""
        with self._lock:
            stats = dict(self._stats)
            stats["tools"] = dict(self._stats["tools"])
            if stats["total_calls"] > 0:
                stats["avg_duration_ms"] = round(stats["total_duration_ms"] / stats["total_calls"], 1)
                stats["error_rate"] = round(stats["error_count"] / stats["total_calls"], 4)
            else:
                stats["avg_duration_ms"] = 0
                stats["error_rate"] = 0
        return stats


# ---------------------------------------------------------------------------
# Global Audit Logger Instance
# ---------------------------------------------------------------------------

_audit_log_dir = os.getenv("SHOPLIVE_AUDIT_DIR", "").strip() or None
_audit_log_file = Path(_audit_log_dir) / "audit.jsonl" if _audit_log_dir else None

audit_log = AuditLogger(
    max_buffer_size=2000,
    log_file=_audit_log_file,
)


# ---------------------------------------------------------------------------
# Flask Middleware Integration
# ---------------------------------------------------------------------------

def setup_audit_middleware(app):
    """Register Flask before/after request hooks for automatic tracing.

    Automatically:
    - Generates trace_id for every request
    - Records request/response timing
    - Adds trace_id to response headers
    """

    @app.before_request
    def _audit_before():
        from flask import request
        # Extract or generate trace_id
        trace_id = (
            request.headers.get("X-Trace-Id")
            or request.headers.get("X-Request-Id")
            or uuid.uuid4().hex[:16]
        )
        user_id = request.headers.get("X-User-Id", "")
        session_id = request.headers.get("X-Session-Id", "")
        start_trace(trace_id=trace_id, user_id=user_id, session_id=session_id)

    @app.after_request
    def _audit_after(response):
        # Add trace_id to response headers for client correlation
        response.headers["X-Trace-Id"] = get_trace_id()
        trace_ctx = get_trace_context()
        if trace_ctx.get("call_chain"):
            response.headers["X-Call-Chain-Length"] = str(len(trace_ctx["call_chain"]))
        return response

    return app
