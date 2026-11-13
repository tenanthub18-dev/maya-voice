"""Real SDK client lifecycle/configuration; no provider requests are made."""

import asyncio

import pytest

from voice_receptionist_worker.pipeline.builder import (
    _create_voice_llm,
    _language_settings_factory,
)

pytestmark = pytest.mark.filterwarnings(
    "ignore:'audioop' is deprecated.*:DeprecationWarning"
)


@pytest.fixture
def providers(monkeypatch):
    monkeypatch.setenv("OPENAI_API_KEY", "test-key")
    monkeypatch.delenv("OPENAI_BASE_URL", raising=False)
    monkeypatch.delenv("VOICE_LLM_MODEL", raising=False)
    monkeypatch.delenv("VOICE_LLM_REASONING", raising=False)
    return {
        "voice_llm": {
            "provider": "openai",
            "model": "gpt-4.1-mini",
            "max_output_tokens": 256,
            "reasoning_effort": "none",
            "service_tier": "default",
        },
    }


def test_builder_cleanup_closes_real_client_without_closing_another_call(providers):
    async def scenario():
        first = _create_voice_llm(providers, "First caller.")
        second = _create_voice_llm(providers, "Second caller.")
        try:
            assert first._client is not second._client
            assert first._client._client is not second._client._client
            assert not first._client.is_closed()
            await first.cleanup()
            assert first._client.is_closed()
            assert first._client._client.is_closed
            assert not second._client.is_closed()
            await first.cleanup()
            await second.cleanup()
            assert second._client.is_closed()
        finally:
            await first._client.close()
            await second._client.close()

    asyncio.run(scenario())


@pytest.mark.parametrize("with_extra", [True, False])
def test_builder_preserves_settings_and_native_client_defaults(providers, with_extra):
    if not with_extra:
        providers["voice_llm"].pop("reasoning_effort")
        providers["voice_llm"].pop("service_tier")

    async def scenario():
        service = _create_voice_llm(providers, "Restaurant rules.")
        try:
            assert type(service).__name__ == "OpenAILLMService"
            assert service._settings.model == "gpt-4.1-mini"
            assert service._settings.system_instruction == "Restaurant rules."
            assert service._settings.max_completion_tokens == 256
            assert service._settings.extra == (
                {"reasoning_effort": "none", "service_tier": "default"} if with_extra else {}
            )
            delta = _language_settings_factory(providers, "Restaurant rules.")("hi")
            assert isinstance(delta, service.Settings)
            assert "caller_language: hi" in delta.system_instruction
            assert str(service._client.base_url) == "https://api.openai.com/v1/"
            assert service._client.api_key == "test-key"
            # Integration check of the pinned HTTPX 0.28.1 real transport.
            pool = service._client._client._transport._pool
            assert pool._http2 is False
            assert pool._http1 is True
            assert pool._max_keepalive_connections == 100
            assert pool._max_connections == 1000
            assert pool._keepalive_expiry is None
        finally:
            await service.cleanup()
            await service._client.close()

    asyncio.run(scenario())


def test_client_factory_preserves_custom_endpoint_and_auth_headers(providers):
    async def scenario():
        service = _create_voice_llm(providers, "Restaurant rules.")
        client = service.create_client(
            api_key="custom-test-key",
            base_url="https://llm.example.test/v1",
            organization="test-organization",
            project="test-project",
            default_headers={"X-Call-Route": "test-route"},
        )
        try:
            assert str(client.base_url) == "https://llm.example.test/v1/"
            assert client.auth_headers == {"Authorization": "Bearer custom-test-key"}
            assert client.default_headers["OpenAI-Organization"] == "test-organization"
            assert client.default_headers["OpenAI-Project"] == "test-project"
            assert client.default_headers["X-Call-Route"] == "test-route"
        finally:
            await client.close()
            await service.cleanup()
            await service._client.close()

    asyncio.run(scenario())


@pytest.mark.parametrize("error_type", [RuntimeError, asyncio.CancelledError])
def test_cleanup_closes_client_when_processor_cleanup_fails(providers, monkeypatch, error_type):
    from pipecat.services.openai.llm import OpenAILLMService as PipecatOpenAILLMService

    async def fail_cleanup(self):
        raise error_type()

    monkeypatch.setattr(PipecatOpenAILLMService, "cleanup", fail_cleanup)

    async def scenario():
        service = _create_voice_llm(providers, "Restaurant rules.")
        try:
            with pytest.raises(error_type):
                await service.cleanup()
            assert service._client.is_closed()
        finally:
            await service._client.close()

    asyncio.run(scenario())
