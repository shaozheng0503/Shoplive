"""
Tests for backend/validation.py — validate_request decorator.

Uses a minimal Flask test app to verify the decorator's behaviour:
- Structured 400 on validation failure
- g.req set on success
- recovery_suggestion points to OpenAPI schema
"""
import pytest
from flask import Flask, g, jsonify
from pydantic import BaseModel, Field
from typing import Literal, Optional

from shoplive.backend.validation import validate_request


# ---------------------------------------------------------------------------
# Fixture: minimal Flask app with test routes
# ---------------------------------------------------------------------------

class SimpleSchema(BaseModel):
    name: str = Field(description="Required name field")
    count: int = Field(default=1, ge=1, le=10, description="Count 1-10")
    mode: Literal["fast", "slow"] = Field(default="fast")
    tag: Optional[str] = Field(default=None)


class RequiredOnlySchema(BaseModel):
    url: str = Field(description="Required URL")
    action: Literal["start", "stop"] = Field(description="Action to perform")


@pytest.fixture
def app():
    flask_app = Flask(__name__)
    flask_app.testing = True

    @flask_app.post("/test/simple")
    @validate_request(SimpleSchema)
    def route_simple():
        req = g.req
        return jsonify({"ok": True, "name": req.name, "count": req.count, "mode": req.mode})

    @flask_app.post("/test/required-only")
    @validate_request(RequiredOnlySchema)
    def route_required_only():
        req = g.req
        return jsonify({"ok": True, "url": req.url, "action": req.action})

    @flask_app.post("/test/echo-req")
    @validate_request(SimpleSchema)
    def route_echo_req():
        # Verify g.req is properly typed
        assert isinstance(g.req, SimpleSchema)
        return jsonify({"ok": True, "tag": g.req.tag})

    return flask_app


@pytest.fixture
def client(app):
    return app.test_client()


# ---------------------------------------------------------------------------
# Happy path
# ---------------------------------------------------------------------------

class TestValidateRequestSuccess:
    def test_valid_request_passes_through(self, client):
        resp = client.post("/test/simple", json={"name": "Widget", "count": 3})
        assert resp.status_code == 200
        data = resp.get_json()
        assert data["ok"] is True
        assert data["name"] == "Widget"
        assert data["count"] == 3
        assert data["mode"] == "fast"  # default applied

    def test_defaults_applied_by_pydantic(self, client):
        resp = client.post("/test/simple", json={"name": "Test"})
        assert resp.status_code == 200
        data = resp.get_json()
        assert data["count"] == 1    # default
        assert data["mode"] == "fast"  # default

    def test_g_req_is_pydantic_model_instance(self, client):
        resp = client.post("/test/echo-req", json={"name": "X"})
        assert resp.status_code == 200
        assert resp.get_json()["ok"] is True

    def test_optional_field_none_when_absent(self, client):
        resp = client.post("/test/echo-req", json={"name": "X"})
        data = resp.get_json()
        assert data["tag"] is None

    def test_optional_field_set_when_provided(self, client):
        resp = client.post("/test/echo-req", json={"name": "X", "tag": "promo"})
        data = resp.get_json()
        assert data["tag"] == "promo"

    def test_empty_json_body_uses_all_defaults_for_optional_fields(self, client):
        # When no required fields exist, empty body should succeed
        resp = client.post("/test/simple", json={})
        # "name" is required (no default) → should fail
        assert resp.status_code == 400

    def test_valid_literal_value_accepted(self, client):
        resp = client.post("/test/simple", json={"name": "T", "mode": "slow"})
        assert resp.status_code == 200

    def test_required_fields_all_provided(self, client):
        resp = client.post("/test/required-only", json={"url": "https://x.com", "action": "start"})
        assert resp.status_code == 200
        assert resp.get_json()["url"] == "https://x.com"


# ---------------------------------------------------------------------------
# Validation failure — error structure
# ---------------------------------------------------------------------------

class TestValidateRequestFailure:
    def test_missing_required_field_returns_400(self, client):
        resp = client.post("/test/simple", json={})
        assert resp.status_code == 400

    def test_error_code_is_validation_error(self, client):
        resp = client.post("/test/simple", json={})
        data = resp.get_json()
        assert data["error_code"] == "VALIDATION_ERROR"

    def test_ok_is_false_on_failure(self, client):
        resp = client.post("/test/simple", json={})
        assert resp.get_json()["ok"] is False

    def test_error_message_mentions_field(self, client):
        resp = client.post("/test/simple", json={})
        data = resp.get_json()
        assert "name" in data["error"]

    def test_validation_errors_list_present(self, client):
        resp = client.post("/test/simple", json={})
        data = resp.get_json()
        assert isinstance(data["validation_errors"], list)
        assert len(data["validation_errors"]) >= 1

    def test_validation_errors_have_field_key(self, client):
        resp = client.post("/test/simple", json={})
        data = resp.get_json()
        first_err = data["validation_errors"][0]
        assert "field" in first_err
        assert "message" in first_err
        assert "type" in first_err

    def test_recovery_suggestion_present(self, client):
        resp = client.post("/test/simple", json={})
        data = resp.get_json()
        assert "recovery_suggestion" in data
        assert len(data["recovery_suggestion"]) > 0

    def test_recovery_suggestion_references_openapi(self, client):
        resp = client.post("/test/simple", json={})
        data = resp.get_json()
        assert "/api/openapi.json" in data["recovery_suggestion"]

    def test_recovery_suggestion_mentions_schema_class(self, client):
        resp = client.post("/test/simple", json={})
        data = resp.get_json()
        assert "SimpleSchema" in data["recovery_suggestion"]

    def test_invalid_literal_returns_400(self, client):
        resp = client.post("/test/simple", json={"name": "T", "mode": "turbo"})
        assert resp.status_code == 400
        data = resp.get_json()
        assert data["error_code"] == "VALIDATION_ERROR"
        assert any(e["field"] == "mode" for e in data["validation_errors"])

    def test_out_of_range_int_returns_400(self, client):
        resp = client.post("/test/simple", json={"name": "T", "count": 99})
        assert resp.status_code == 400
        data = resp.get_json()
        assert any(e["field"] == "count" for e in data["validation_errors"])

    def test_wrong_type_returns_400(self, client):
        # count expects int, passing a non-numeric string
        resp = client.post("/test/simple", json={"name": "T", "count": "not-a-number"})
        assert resp.status_code == 400

    def test_null_body_returns_400_on_required_field(self, client):
        # POST with no JSON body at all
        resp = client.post("/test/simple", content_type="application/json")
        assert resp.status_code == 400

    def test_multiple_errors_all_reported(self, client):
        # Both "url" and "action" are required and missing
        resp = client.post("/test/required-only", json={})
        data = resp.get_json()
        assert len(data["validation_errors"]) >= 2
        fields = {e["field"] for e in data["validation_errors"]}
        assert "url" in fields
        assert "action" in fields


# ---------------------------------------------------------------------------
# Decorator preserves function name
# ---------------------------------------------------------------------------

class TestValidateRequestDecorator:
    def test_functools_wraps_preserves_name(self):
        flask_app = Flask(__name__)

        @flask_app.post("/introspect")
        @validate_request(SimpleSchema)
        def my_special_handler():
            return jsonify({"ok": True})

        assert my_special_handler.__name__ == "my_special_handler"
