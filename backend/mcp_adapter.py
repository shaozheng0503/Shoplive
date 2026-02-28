"""
MCP (Model Context Protocol) Adapter for Shoplive.

Automatically converts the internal Tool Registry into MCP-standard
Tool Definitions, enabling any MCP-compatible Agent framework to
discover and invoke Shoplive tools.

Reference: https://modelcontextprotocol.io/docs/concepts/tools

MCP Tool Definition format:
{
    "name": "tool_name",
    "description": "...",
    "inputSchema": { JSON Schema },
}
"""

from typing import Any, Dict, List, Optional

from shoplive.backend.tool_registry import TOOL_REGISTRY, SKILL_DEFINITIONS
from shoplive.backend.schemas import TOOL_SCHEMAS


# ---------------------------------------------------------------------------
# MCP Tool Definition Builder
# ---------------------------------------------------------------------------

def _pydantic_to_json_schema(model_cls) -> Dict[str, Any]:
    """Convert a Pydantic model class to a JSON Schema dict (MCP inputSchema)."""
    try:
        return model_cls.model_json_schema()
    except Exception:
        return {"type": "object", "properties": {}}


def _build_mcp_tool(tool_def: Dict[str, Any]) -> Dict[str, Any]:
    """Convert an internal tool definition to MCP Tool Definition format."""
    name = tool_def["name"]

    # Try to get the Pydantic schema for structured inputSchema
    schema_cls = TOOL_SCHEMAS.get(name)
    if schema_cls:
        input_schema = _pydantic_to_json_schema(schema_cls)
    else:
        # Fallback: build schema from the parameters dict in tool_registry
        properties = {}
        required = []
        for param_name, param_def in tool_def.get("parameters", {}).items():
            prop: Dict[str, Any] = {}
            param_type = param_def.get("type", "string")
            if param_type == "array":
                prop["type"] = "array"
            elif param_type == "object":
                prop["type"] = "object"
            elif param_type == "integer":
                prop["type"] = "integer"
            elif param_type == "boolean":
                prop["type"] = "boolean"
            else:
                prop["type"] = "string"
            if "description" in param_def:
                prop["description"] = param_def["description"]
            if "enum" in param_def:
                prop["enum"] = param_def["enum"]
            if "default" in param_def:
                prop["default"] = param_def["default"]
            properties[param_name] = prop
            if param_def.get("required"):
                required.append(param_name)
        input_schema = {
            "type": "object",
            "properties": properties,
        }
        if required:
            input_schema["required"] = required

    # Build the MCP tool definition
    mcp_tool: Dict[str, Any] = {
        "name": name,
        "description": tool_def.get("description", ""),
        "inputSchema": input_schema,
    }

    # MCP extension: annotations for tool behavior hints
    annotations: Dict[str, Any] = {}
    tags = tool_def.get("tags", [])
    if "generation" in tags or "chain" in tags:
        annotations["readOnlyHint"] = False
        annotations["openWorldHint"] = True
    else:
        annotations["readOnlyHint"] = "analysis" in tags or "status" in tags
        annotations["openWorldHint"] = "scraping" in tags

    # Destructive hint for edit/delete operations
    annotations["destructiveHint"] = False
    annotations["idempotentHint"] = name in {"check_video_status", "chat_with_llm"}

    mcp_tool["annotations"] = annotations

    return mcp_tool


def build_mcp_tools_list() -> List[Dict[str, Any]]:
    """Build the complete list of MCP Tool Definitions from the registry."""
    return [_build_mcp_tool(t) for t in TOOL_REGISTRY]


def build_mcp_tools_by_skill(skill_name: str) -> List[Dict[str, Any]]:
    """Build MCP Tool Definitions filtered by skill (progressive disclosure)."""
    skill_tools = [t for t in TOOL_REGISTRY if t.get("skill") == skill_name]
    return [_build_mcp_tool(t) for t in skill_tools]


# ---------------------------------------------------------------------------
# MCP Server Info
# ---------------------------------------------------------------------------

def build_mcp_server_info() -> Dict[str, Any]:
    """Build the MCP server capabilities manifest."""
    return {
        "protocolVersion": "2025-03-26",
        "serverInfo": {
            "name": "shoplive-mcp-server",
            "version": "1.0.0",
        },
        "capabilities": {
            "tools": {
                "listChanged": False,
            },
        },
    }


def build_mcp_tools_response(cursor: Optional[str] = None) -> Dict[str, Any]:
    """Build the tools/list response in MCP format."""
    tools = build_mcp_tools_list()
    return {
        "tools": tools,
    }


# ---------------------------------------------------------------------------
# MCP JSON-RPC Handler
# ---------------------------------------------------------------------------

def handle_mcp_request(rpc_body: Dict[str, Any]) -> Dict[str, Any]:
    """Handle an MCP JSON-RPC 2.0 request.

    Supports:
    - initialize: Server handshake
    - tools/list: Enumerate available tools
    - tools/call: Execute a tool (delegated to Flask routes)
    """
    method = rpc_body.get("method", "")
    request_id = rpc_body.get("id")
    params = rpc_body.get("params", {})

    if method == "initialize":
        return {
            "jsonrpc": "2.0",
            "id": request_id,
            "result": build_mcp_server_info(),
        }

    if method == "tools/list":
        return {
            "jsonrpc": "2.0",
            "id": request_id,
            "result": build_mcp_tools_response(cursor=params.get("cursor")),
        }

    if method == "tools/call":
        tool_name = params.get("name", "")
        arguments = params.get("arguments", {})
        # Delegate to the tool executor
        result = _execute_tool(tool_name, arguments)
        return {
            "jsonrpc": "2.0",
            "id": request_id,
            "result": result,
        }

    # Unknown method
    return {
        "jsonrpc": "2.0",
        "id": request_id,
        "error": {
            "code": -32601,
            "message": f"Method not found: {method}",
        },
    }


def _execute_tool(tool_name: str, arguments: Dict[str, Any]) -> Dict[str, Any]:
    """Execute a tool by name, routing to the appropriate Flask endpoint.

    Returns MCP CallToolResult format:
    {
        "content": [{"type": "text", "text": "..."}],
        "isError": false
    }
    """
    # Map tool names to Flask endpoints
    tool_endpoint_map = {
        "parse_product_url": ("api_agent_shop_product_insight", "/api/agent/shop-product-insight"),
        "analyze_product_image": ("api_agent_image_insight", "/api/agent/image-insight"),
        "chat_with_llm": ("api_agent_chat", "/api/agent/chat"),
        "run_video_workflow": ("api_shoplive_video_workflow", "/api/shoplive/video/workflow"),
        "generate_video": ("api_veo_start", "/api/veo/start"),
        "chain_video_segments": ("api_veo_chain", "/api/veo/chain"),
        "check_video_status": ("api_veo_status", "/api/veo/status"),
        "extend_video": ("api_veo_extend", "/api/veo/extend"),
        "export_edited_video": ("api_video_edit_export", "/api/video/edit/export"),
        "generate_product_image": ("api_shoplive_image_generate", "/api/shoplive/image/generate"),
    }

    if tool_name not in tool_endpoint_map:
        return {
            "content": [{"type": "text", "text": f"Unknown tool: {tool_name}"}],
            "isError": True,
        }

    view_name, endpoint_path = tool_endpoint_map[tool_name]

    try:
        from shoplive.backend.web_app import app
        import json

        with app.test_request_context(endpoint_path, method="POST", json=arguments):
            view_func = app.view_functions.get(view_name)
            if not view_func:
                return {
                    "content": [{"type": "text", "text": f"Endpoint not found: {view_name}"}],
                    "isError": True,
                }
            response = view_func()
            # Handle tuple responses (body, status_code)
            if isinstance(response, tuple):
                resp_body, status_code = response[0], response[1]
            else:
                resp_body = response
                status_code = 200

            resp_json = resp_body.get_json(silent=True) if hasattr(resp_body, "get_json") else {}
            is_error = status_code >= 400

            return {
                "content": [{"type": "text", "text": json.dumps(resp_json, ensure_ascii=False)}],
                "isError": is_error,
            }
    except Exception as e:
        return {
            "content": [{"type": "text", "text": f"Tool execution error: {e}"}],
            "isError": True,
        }
