"""
Tests for backend/audit.py — full-chain audit & observability.

Verifies in-memory buffering, statistics tracking, trace context,
and error classification without any I/O.
"""
import tempfile
import threading
import time
from pathlib import Path

import pytest

from shoplive.backend.audit import (
    AuditLogger,
    AuditRecord,
    append_to_call_chain,
    get_trace_context,
    get_trace_id,
    start_trace,
)


# ---------------------------------------------------------------------------
# AuditRecord
# ---------------------------------------------------------------------------

class TestAuditRecord:
    def test_to_dict_success(self):
        rec = AuditRecord(
            tool="parse_product_url",
            action="scrape",
            trace_id="abc123",
            input_summary={"url": "https://amazon.com"},
            output_summary={"confidence": "high"},
            status="success",
            duration_ms=250,
        )
        d = rec.to_dict()
        assert d["tool"] == "parse_product_url"
        assert d["status"] == "success"
        assert d["duration_ms"] == 250
        assert "error_code" not in d  # omitted when absent
        assert "error_message" not in d

    def test_to_dict_error_fields_included(self):
        rec = AuditRecord(
            tool="generate_video",
            action="veo_start",
            trace_id="t1",
            input_summary={},
            output_summary={},
            status="error",
            duration_ms=100,
            error_code="VEO_SUBMIT_FAILED",
            error_message="connection refused",
        )
        d = rec.to_dict()
        assert d["error_code"] == "VEO_SUBMIT_FAILED"
        assert d["error_message"] == "connection refused"

    def test_to_json_is_valid(self):
        import json
        rec = AuditRecord(
            tool="t", action="a", trace_id="x",
            input_summary={}, output_summary={},
            status="success", duration_ms=0,
        )
        parsed = json.loads(rec.to_json())
        assert parsed["tool"] == "t"

    def test_timestamp_is_utc_iso(self):
        rec = AuditRecord(
            tool="t", action="a", trace_id="x",
            input_summary={}, output_summary={},
            status="success", duration_ms=0,
        )
        # UTC ISO 8601: ends with +00:00 or Z
        assert rec.timestamp.endswith("+00:00") or rec.timestamp.endswith("Z")


# ---------------------------------------------------------------------------
# AuditLogger — basic recording
# ---------------------------------------------------------------------------

class TestAuditLoggerBasic:
    def setup_method(self):
        self.logger = AuditLogger(max_buffer_size=100)

    def test_record_increases_total_calls(self):
        self.logger.record(tool="t", action="a", status="success", duration_ms=10)
        stats = self.logger.get_stats()
        assert stats["total_calls"] == 1

    def test_record_success_counted(self):
        self.logger.record(tool="t", action="a", status="success")
        stats = self.logger.get_stats()
        assert stats["success_count"] == 1
        assert stats["error_count"] == 0

    def test_record_error_counted(self):
        self.logger.record(tool="t", action="a", status="error")
        stats = self.logger.get_stats()
        assert stats["error_count"] == 1
        assert stats["success_count"] == 0

    def test_per_tool_stats(self):
        self.logger.record(tool="parse_product_url", action="scrape", duration_ms=200)
        self.logger.record(tool="parse_product_url", action="scrape", duration_ms=300, status="error")
        stats = self.logger.get_stats()
        tool_stats = stats["tools"]["parse_product_url"]
        assert tool_stats["calls"] == 2
        assert tool_stats["errors"] == 1
        assert tool_stats["total_ms"] == 500

    def test_avg_duration_ms(self):
        self.logger.record(tool="t", action="a", duration_ms=100)
        self.logger.record(tool="t", action="a", duration_ms=200)
        stats = self.logger.get_stats()
        assert stats["avg_duration_ms"] == 150.0

    def test_error_rate(self):
        self.logger.record(tool="t", action="a", status="success")
        self.logger.record(tool="t", action="a", status="error")
        stats = self.logger.get_stats()
        assert stats["error_rate"] == 0.5


# ---------------------------------------------------------------------------
# AuditLogger — buffer and retrieval
# ---------------------------------------------------------------------------

class TestAuditLoggerRetrieval:
    def setup_method(self):
        self.logger = AuditLogger(max_buffer_size=10)

    def test_get_recent_returns_correct_count(self):
        for i in range(5):
            self.logger.record(tool=f"tool_{i}", action="a")
        recent = self.logger.get_recent(limit=3)
        assert len(recent) == 3

    def test_get_recent_is_newest_last(self):
        for i in range(5):
            self.logger.record(tool=f"tool_{i}", action="a")
        recent = self.logger.get_recent(limit=5)
        assert recent[-1]["tool"] == "tool_4"

    def test_buffer_ring_overflow(self):
        # max_buffer_size=10; add 15 records
        for i in range(15):
            self.logger.record(tool=f"t{i}", action="a")
        recent = self.logger.get_recent(limit=20)
        assert len(recent) == 10  # capped at buffer size

    def test_get_trace_filters_by_trace_id(self):
        start_trace("trace-A")
        self.logger.record(tool="tool_a", action="x")
        start_trace("trace-B")
        self.logger.record(tool="tool_b", action="y")

        records_a = self.logger.get_trace("trace-A")
        assert all(r["trace_id"] == "trace-A" for r in records_a)
        assert any(r["tool"] == "tool_a" for r in records_a)

    def test_get_trace_empty_for_unknown_id(self):
        assert self.logger.get_trace("nonexistent-trace") == []


# ---------------------------------------------------------------------------
# AuditLogger — file persistence
# ---------------------------------------------------------------------------

class TestAuditLoggerFilePersistence:
    def test_records_written_to_jsonl(self):
        import json
        with tempfile.TemporaryDirectory() as tmpdir:
            log_path = Path(tmpdir) / "audit.jsonl"
            logger = AuditLogger(log_file=log_path)
            logger.record(tool="veo", action="start", duration_ms=50)
            logger.record(tool="veo", action="status", status="error")

            lines = log_path.read_text().strip().split("\n")
            assert len(lines) == 2
            first = json.loads(lines[0])
            assert first["tool"] == "veo"
            assert first["action"] == "start"

    def test_log_directory_created_automatically(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            deep_path = Path(tmpdir) / "a" / "b" / "audit.jsonl"
            logger = AuditLogger(log_file=deep_path)
            logger.record(tool="t", action="a")
            assert deep_path.exists()


# ---------------------------------------------------------------------------
# Trace context
# ---------------------------------------------------------------------------

class TestTraceContext:
    def test_start_trace_sets_trace_id(self):
        start_trace("test-trace-123")
        assert get_trace_id() == "test-trace-123"

    def test_start_trace_auto_generates_id(self):
        start_trace()
        tid = get_trace_id()
        assert len(tid) == 16
        assert tid != "no-trace"

    def test_call_chain_appended(self):
        start_trace("chain-test")
        append_to_call_chain("tool_x", "success", 100)
        append_to_call_chain("tool_y", "error", 200)
        ctx = get_trace_context()
        chain = ctx["call_chain"]
        assert len(chain) == 2
        assert chain[0]["tool"] == "tool_x"
        assert chain[1]["seq"] == 2

    def test_elapsed_ms_non_negative(self):
        start_trace()
        time.sleep(0.01)
        ctx = get_trace_context()
        assert ctx["elapsed_ms"] >= 0

    def test_no_trace_fallback(self):
        # Clear trace context by starting fresh
        import threading
        result = {}
        def _check_in_new_thread():
            # New thread has no trace context
            result["tid"] = get_trace_id()
        t = threading.Thread(target=_check_in_new_thread)
        t.start()
        t.join()
        assert result["tid"] == "no-trace"


# ---------------------------------------------------------------------------
# Thread safety
# ---------------------------------------------------------------------------

class TestAuditLoggerThreadSafety:
    def test_concurrent_records_all_counted(self):
        logger = AuditLogger(max_buffer_size=1000)
        errors = []

        def _worker(n):
            try:
                for _ in range(n):
                    logger.record(tool="t", action="a", status="success")
            except Exception as e:
                errors.append(e)

        threads = [threading.Thread(target=_worker, args=(20,)) for _ in range(10)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()

        assert not errors
        stats = logger.get_stats()
        assert stats["total_calls"] == 200
        assert stats["success_count"] == 200
