from __future__ import annotations

import asyncio
import copy
import uuid
from collections.abc import Mapping
from typing import Any, Protocol

import httpx


class RepositoryError(RuntimeError):
    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code


class Repository(Protocol):
    async def select(
        self, table: str, filters: Mapping[str, Any] | None = None
    ) -> list[dict[str, Any]]: ...

    async def insert(self, table: str, row: Mapping[str, Any]) -> dict[str, Any]: ...

    async def update(
        self, table: str, filters: Mapping[str, Any], values: Mapping[str, Any]
    ) -> dict[str, Any]: ...

    async def create_booking(self, row: Mapping[str, Any]) -> dict[str, Any]: ...

    async def rpc(self, name: str, arguments: Mapping[str, Any]) -> dict[str, Any]: ...


class InMemoryRepository:
    """Concurrency-safe repository used by unit tests and local development."""

    def __init__(
        self,
        *,
        restaurant: Mapping[str, Any],
        hours: list[Mapping[str, Any]],
        menu_items: list[Mapping[str, Any]],
        slots_config: Mapping[str, Any],
    ) -> None:
        self._tables: dict[str, list[dict[str, Any]]] = {
            "restaurants": [dict(restaurant)],
            "hours": [dict(row, restaurant_id=restaurant["id"]) for row in hours],
            "hours_overrides": [],
            "menu_items": [dict(row, restaurant_id=restaurant["id"]) for row in menu_items],
            "menu_modifiers": [],
            "slots_config": [dict(slots_config, restaurant_id=restaurant["id"])],
            "bookings": [],
            "orders": [],
            "order_items": [],
            "messages": [],
            "sms_log": [],
            "sms_optouts": [],
            "tool_invocations": [],
            "calls": [],
            "call_turns": [],
            "usage_ledger": [],
        }
        self._booking_lock = asyncio.Lock()
        self._write_count = 0

    @property
    def write_count(self) -> int:
        return self._write_count

    def rows(self, table: str) -> list[dict[str, Any]]:
        return copy.deepcopy(self._tables.get(table, []))

    def seed(self, table: str, rows: list[Mapping[str, Any]]) -> None:
        self._tables.setdefault(table, []).extend(copy.deepcopy([dict(row) for row in rows]))

    @staticmethod
    def _matches(row: Mapping[str, Any], filters: Mapping[str, Any]) -> bool:
        return all(row.get(key) == value for key, value in filters.items())

    async def select(
        self, table: str, filters: Mapping[str, Any] | None = None
    ) -> list[dict[str, Any]]:
        filters = filters or {}
        return copy.deepcopy(
            [row for row in self._tables.get(table, []) if self._matches(row, filters)]
        )

    async def insert(self, table: str, row: Mapping[str, Any]) -> dict[str, Any]:
        record = dict(row)
        record.setdefault("id", str(uuid.uuid4()))
        if table == "tool_invocations":
            existing = next(
                (
                    item
                    for item in self._tables[table]
                    if item.get("idempotency_key") == record.get("idempotency_key")
                ),
                None,
            )
            if existing:
                return copy.deepcopy(existing)
        self._tables.setdefault(table, []).append(record)
        self._write_count += 1
        return copy.deepcopy(record)

    async def update(
        self, table: str, filters: Mapping[str, Any], values: Mapping[str, Any]
    ) -> dict[str, Any]:
        for row in self._tables.get(table, []):
            if self._matches(row, filters):
                row.update(values)
                self._write_count += 1
                return copy.deepcopy(row)
        raise RepositoryError("not_found", f"No {table} row matched")

    async def create_booking(self, row: Mapping[str, Any]) -> dict[str, Any]:
        async with self._booking_lock:
            restaurant_id = row["restaurant_id"]
            starts_at = row["starts_at"]
            party_size = int(row["party_size"])
            config = (await self.select("slots_config", {"restaurant_id": restaurant_id}))[0]
            reserved = sum(
                int(row["party_size"])
                for row in self._tables["bookings"]
                if row["restaurant_id"] == restaurant_id
                and row["starts_at"] == starts_at
                and row["status"] in {"confirmed", "seated"}
            )
            if reserved + party_size > int(config["covers_per_slot"]):
                raise RepositoryError("slot_unavailable", "That time is no longer available")
            return await self.insert("bookings", row)

    async def rpc(self, name: str, arguments: Mapping[str, Any]) -> dict[str, Any]:
        raise RepositoryError("unsupported_rpc", f"Unsupported RPC: {name}")


class SupabasePostgrestRepository:
    """Supabase Data API client using documented PostgREST HTTP endpoints.

    API-key behavior: https://supabase.com/docs/guides/api/api-keys
    REST/RPC behavior: https://supabase.com/docs/guides/api
    """

    def __init__(
        self,
        url: str,
        secret_key: str,
        *,
        client: httpx.AsyncClient | None = None,
        timeout_seconds: float = 5.0,
    ) -> None:
        self._base_url = url.rstrip("/") + "/rest/v1"
        self._headers = {
            "apikey": secret_key,
            "Content-Type": "application/json",
        }
        if secret_key.count(".") == 2:
            self._headers["Authorization"] = f"Bearer {secret_key}"
        self._client = client or httpx.AsyncClient(timeout=timeout_seconds)
        self._owns_client = client is None

    async def aclose(self) -> None:
        if self._owns_client:
            await self._client.aclose()

    async def _request(self, method: str, path: str, **kwargs: Any) -> Any:
        headers = {**self._headers, **kwargs.pop("headers", {})}
        try:
            response = await self._client.request(
                method, f"{self._base_url}/{path}", headers=headers, **kwargs
            )
        except httpx.HTTPError as error:
            raise RepositoryError("unreachable", "Supabase is unreachable") from error
        if response.is_error:
            try:
                body = response.json()
                code = str(body.get("code", response.status_code))
                message = str(body.get("message", "Supabase request failed"))
            except ValueError:
                code, message = str(response.status_code), "Supabase request failed"
            if code == "23514" and "CAPACITY" in message:
                code = "slot_unavailable"
            raise RepositoryError(code, message)
        return response.json() if response.content else None

    async def select(
        self, table: str, filters: Mapping[str, Any] | None = None
    ) -> list[dict[str, Any]]:
        params: dict[str, str] = {"select": "*"}
        params.update({key: f"eq.{value}" for key, value in (filters or {}).items()})
        result = await self._request("GET", table, params=params)
        return list(result or [])

    async def insert(self, table: str, row: Mapping[str, Any]) -> dict[str, Any]:
        result = await self._request(
            "POST",
            table,
            json=dict(row),
            headers={**self._headers, "Prefer": "return=representation"},
        )
        return dict(result[0])

    async def update(
        self, table: str, filters: Mapping[str, Any], values: Mapping[str, Any]
    ) -> dict[str, Any]:
        params = {key: f"eq.{value}" for key, value in filters.items()}
        result = await self._request(
            "PATCH",
            table,
            params=params,
            json=dict(values),
            headers={**self._headers, "Prefer": "return=representation"},
        )
        if not result:
            raise RepositoryError("not_found", f"No {table} row matched")
        return dict(result[0])

    async def create_booking(self, row: Mapping[str, Any]) -> dict[str, Any]:
        # A normal PostgREST insert executes the existing BEFORE INSERT
        # enforce_booking_capacity trigger, whose advisory transaction lock
        # serializes concurrent calls while preserving call_id atomically.
        return await self.insert("bookings", row)

    async def rpc(self, name: str, arguments: Mapping[str, Any]) -> dict[str, Any]:
        result = await self._request(
            "POST",
            f"rpc/{name}",
            json=dict(arguments),
            headers={**self._headers, "Prefer": "return=representation"},
        )
        return dict(result[0] if isinstance(result, list) else result)
