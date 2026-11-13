from __future__ import annotations

from typing import Any

from pipecat.adapters.llm.schemas.function_schema import FunctionSchema
from pipecat.adapters.llm.schemas.tools_schema import ToolsSchema


def _string(description: str, *, enum: list[str] | None = None) -> dict[str, Any]:
    schema: dict[str, Any] = {"type": "string", "description": description}
    if enum:
        schema["enum"] = enum
    return schema


def build_tool_schemas() -> ToolsSchema:
    """Return Pipecat-compatible typed tool declarations.

    FunctionSchema/ToolsSchema are from installed Pipecat 1.14.0:
    apps/worker/.venv/lib/python3.12/site-packages/pipecat/adapters/llm/schemas/
    Official guide: https://docs.pipecat.ai/guides/features/llm-functions
    """
    languages = ["en", "fr-CA", "ur", "hi", "pa", "en-IN", "te", "ar"]
    definitions = [
        ("get_hours", "Get opening hours for a date.", {"date": _string("ISO date")}, []),
        ("search_menu", "Fuzzy-search the current menu.", {"query": _string("Food or dish"), "language": _string("Reply language", enum=languages)}, ["query", "language"]),
        ("check_availability", "Find an exact booking slot or nearby alternatives.", {"date": _string("ISO date"), "time": _string("Local HH:MM"), "party_size": {"type": "integer", "minimum": 1}}, ["date", "time", "party_size"]),
        ("create_booking", "Create a confirmed booking after reading details back.", {"name": _string("Guest name"), "phone": _string("E.164 phone"), "party_size": {"type": "integer", "minimum": 1}, "starts_at": _string("ISO datetime"), "notes": _string("Optional notes")}, ["name", "phone", "party_size", "starts_at"]),
        ("find_booking", "Find bookings by caller phone and optional date.", {"phone": _string("E.164 phone"), "date": _string("ISO date")}, ["phone"]),
        ("modify_booking", "Modify a booking after reading it back.", {"booking_id": _string("Booking UUID"), "changes": {"type": "object", "properties": {"starts_at": _string("ISO datetime"), "party_size": {"type": "integer", "minimum": 1}, "notes": _string("Notes")}}}, ["booking_id", "changes"]),
        ("cancel_booking", "Cancel a booking after reading it back.", {"booking_id": _string("Booking UUID"), "changes": {"type": "object", "properties": {}}}, ["booking_id"]),
        ("create_order", "Create an order; server calculates all prices and tax.", {"items": {"type": "array", "minItems": 1, "items": {"type": "object", "properties": {"menu_item_id": _string("Menu item UUID"), "quantity": {"type": "integer", "minimum": 1}, "modifiers": {"type": "array", "items": {"type": "string"}}}, "required": ["menu_item_id", "quantity"]}}, "pickup_at": _string("ISO datetime"), "name": _string("Customer name"), "phone": _string("E.164 phone")}, ["items", "pickup_at", "name", "phone"]),
        ("send_sms", "Send one approved localized SMS template unless opted out; sent means provider acceptance, not delivery.", {"template_key": _string("Approved template key", enum=["booking_confirmation", "order_confirmation", "message_received"]), "vars": {"type": "object", "additionalProperties": True}, "phone": _string("E.164 destination"), "language": _string("Template language", enum=languages)}, ["template_key", "vars", "phone", "language"]),
        ("send_payment_link", "Create a payment-link request when the feature is enabled.", {"order_id": _string("Order UUID"), "booking_id": _string("Booking UUID")}, []),
        ("transfer_call", "Transfer during configured transfer hours.", {"reason": _string("Reason and spoken staff summary")}, ["reason"]),
        ("take_message", "Save a message for the restaurant owner.", {"name": _string("Caller name"), "phone": _string("Caller phone"), "text": _string("Message")}, ["name", "phone", "text"]),
        ("end_call", "End the call after a cached goodbye.", {"reason": _string("End reason")}, ["reason"]),
    ]
    return ToolsSchema(
        standard_tools=[
            FunctionSchema(name, description, properties, required)
            for name, description, properties, required in definitions
        ]
    )


def validate_tool_arguments(name: str, arguments: dict[str, Any] | Any) -> None:
    """Validate LLM-provided arguments against the advertised JSON schema."""
    schema = next(
        (item for item in build_tool_schemas().standard_tools if item.name == name),
        None,
    )
    if schema is None:
        return
    _validate_value(
        arguments,
        {
            "type": "object",
            "properties": schema.properties,
            "required": schema.required,
        },
        "arguments",
    )


def _validate_value(value: Any, schema: dict[str, Any], path: str) -> None:
    expected = schema.get("type")
    if expected == "object":
        if not isinstance(value, dict):
            raise ValueError(f"{path} must be an object")
        properties = schema.get("properties", {})
        unexpected = (
            []
            if schema.get("additionalProperties") is True
            else sorted(set(value) - set(properties))
        )
        if unexpected:
            raise ValueError(f"{path} has unexpected field(s): {', '.join(unexpected)}")
        missing = [key for key in schema.get("required", []) if key not in value]
        if missing:
            raise ValueError(f"{path} missing required fields: {', '.join(missing)}")
        for key, child in properties.items():
            if key in value:
                _validate_value(value[key], child, f"{path}.{key}")
    elif expected == "array":
        if not isinstance(value, list):
            raise ValueError(f"{path} must be an array")
        if len(value) < int(schema.get("minItems", 0)):
            raise ValueError(f"{path} must contain at least {schema['minItems']} item(s)")
        for index, child_value in enumerate(value):
            _validate_value(child_value, schema.get("items", {}), f"{path}[{index}]")
    elif expected == "string":
        if not isinstance(value, str):
            raise ValueError(f"{path} must be a string")
    elif expected == "integer":
        if isinstance(value, bool) or not isinstance(value, int):
            raise ValueError(f"{path} must be an integer")
        if "minimum" in schema and value < schema["minimum"]:
            raise ValueError(f"{path} must be at least {schema['minimum']}")
    if "enum" in schema and value not in schema["enum"]:
        raise ValueError(f"{path} must be one of {', '.join(schema['enum'])}")
