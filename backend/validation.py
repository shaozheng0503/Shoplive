"""
Pydantic request validation decorator for Flask handlers.

Design principle (from "一文读懂 Agent Tools"):
  Type safety — validate all inputs at system boundary before any business logic runs.

Usage:
    from shoplive.backend.validation import validate_request
    from shoplive.backend.schemas import ProductInsightRequest

    @app.post("/api/agent/shop-product-insight")
    @validate_request(ProductInsightRequest)
    def handler():
        req = g.req  # validated ProductInsightRequest instance
        ...
"""
from functools import wraps
from typing import Type

from flask import g, jsonify, request
from pydantic import BaseModel, ValidationError


def validate_request(schema_cls: Type[BaseModel]):
    """Validate incoming JSON body against a Pydantic schema.

    On success: sets ``flask.g.req`` to the validated model instance and
    delegates to the wrapped handler.

    On failure: returns a structured 400 JSON with field-level error details
    and a self-healing ``recovery_suggestion`` so LLMs can auto-correct.
    """

    def decorator(fn):
        @wraps(fn)
        def wrapper(*args, **kwargs):
            payload = request.get_json(silent=True) or {}
            try:
                g.req = schema_cls.model_validate(payload)
            except ValidationError as exc:
                errors = []
                for err in exc.errors(include_url=False):
                    field = ".".join(str(p) for p in err.get("loc", ())) or "unknown"
                    errors.append(
                        {"field": field, "message": err["msg"], "type": err["type"]}
                    )
                first = errors[0] if errors else {}
                field_name = first.get("field", "unknown")
                field_msg = first.get("message", "invalid value")
                return jsonify(
                    {
                        "ok": False,
                        "error": f"Request validation failed: '{field_name}' — {field_msg}",
                        "error_code": "VALIDATION_ERROR",
                        "recovery_suggestion": (
                            f"Fix '{field_name}': {field_msg}. "
                            f"See GET /api/openapi.json → "
                            f"components/schemas/{schema_cls.__name__}."
                        ),
                        "validation_errors": errors,
                    }
                ), 400
            return fn(*args, **kwargs)

        return wrapper

    return decorator
