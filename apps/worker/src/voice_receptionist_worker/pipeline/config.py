from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Any

import yaml


class ProviderConfigError(ValueError):
    """Raised when provider configuration cannot safely start a call."""


@dataclass(frozen=True)
class RuntimeConfig:
    providers: dict[str, Any]
    restaurant: dict[str, Any]


def _load_yaml(path: Path) -> dict[str, Any]:
    text = path.read_text(encoding="utf-8")
    value = yaml.safe_load(text)
    if not isinstance(value, dict):
        raise ProviderConfigError(f"Configuration must be a mapping: {path}")
    return value


def _find_verify(value: object, path: str = "") -> list[str]:
    if isinstance(value, dict):
        unresolved: list[str] = []
        for key, child in value.items():
            child_path = f"{path}.{key}" if path else str(key)
            unresolved.extend(_find_verify(child, child_path))
        return unresolved
    if isinstance(value, list):
        unresolved = []
        for index, child in enumerate(value):
            unresolved.extend(_find_verify(child, f"{path}[{index}]"))
        return unresolved
    return [path] if isinstance(value, str) and value.strip().upper() == "VERIFY" else []


def load_runtime_config(
    providers_path: str | Path,
    restaurant_path: str | Path,
) -> RuntimeConfig:
    providers = _load_yaml(Path(providers_path))
    unresolved = _find_verify(providers)
    if unresolved:
        raise ProviderConfigError(
            f"VERIFY provider config: {', '.join(sorted(unresolved))}"
        )

    required_paths = (
        ("stt", "provider"),
        ("stt", "model"),
        ("llm", "provider"),
        ("llm", "model"),
        ("llm", "max_output_tokens"),
        ("tts", "provider"),
        ("tts", "model"),
        ("tts", "voice"),
        ("telephony", "provider"),
    )
    missing = [
        ".".join(parts)
        for parts in required_paths
        if not isinstance(providers.get(parts[0]), dict)
        or not providers[parts[0]].get(parts[1])
    ]
    if missing:
        raise ProviderConfigError(
            f"VERIFY provider config: missing {', '.join(sorted(missing))}"
        )
    if type(providers["llm"]["max_output_tokens"]) is not int:
        raise ProviderConfigError(
            "VERIFY provider config: llm.max_output_tokens must be an integer"
        )

    restaurant = _load_yaml(Path(restaurant_path))
    if not restaurant.get("name") or not restaurant.get("hours"):
        raise ProviderConfigError("Restaurant config requires name and hours")
    menu = restaurant.get("menu")
    if not isinstance(menu, list) or not menu:
        raise ProviderConfigError("Restaurant config requires at least one menu item")
    return RuntimeConfig(providers=providers, restaurant=restaurant)
