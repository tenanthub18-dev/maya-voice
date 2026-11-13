"""Real SDK lifecycle and HTTP/1 loopback requests; no provider traffic."""

import asyncio
import json
import warnings
from contextlib import asynccontextmanager

import pytest
from loguru import logger
from openai import BadRequestError, NOT_GIVEN as OPENAI_NOT_GIVEN

with warnings.catch_warnings():
    warnings.filterwarnings("ignore", message="'audioop' is deprecated.*", category=DeprecationWarning)
    from pipecat.clocks.system_clock import SystemClock
    from pipecat.frames.frames import InterruptionFrame, StartFrame, TextFrame
    from pipecat.processors.aggregators.llm_context import LLMContext
    from pipecat.processors.frame_processor import FrameProcessorSetup
    from pipecat.services.settings import is_given
    from pipecat.utils.asyncio.task_manager import TaskManager
    from voice_receptionist_worker.pipeline.openai_llm import OpenAILLMService

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


@asynccontextmanager
async def _http1_server(*, metadata_status=200, block_metadata=False, completion_status=200):
    """Keep connections alive and record actual SDK bytes and peer TCP ports."""
    requests = []
    received = asyncio.Queue()
    release = asyncio.Event()
    if not block_metadata:
        release.set()
    handlers = set()

    async def handle(reader, writer):
        handlers.add(asyncio.current_task())
        try:
            while True:
                head = await reader.readuntil(b"\r\n\r\n")
                first, *lines = head.decode("ascii").split("\r\n")
                method, path, version = first.split()
                headers = {key.lower(): value for key, value in
                           (line.split(": ", 1) for line in lines if line)}
                body = await reader.readexactly(int(headers.get("content-length", 0)))
                request = {
                    "method": method, "path": path, "version": version,
                    "headers": headers, "body": body,
                    "peer": writer.get_extra_info("peername"),
                }
                requests.append(request)
                received.put_nowait(request)
                if method == "GET":
                    await release.wait()
                    status = metadata_status
                    payload = json.dumps({
                        "id": path.rsplit("/", 1)[-1], "object": "model",
                        "created": 0, "owned_by": "test",
                    }).encode()
                    content_type = "application/json"
                else:
                    status = completion_status
                    payload = (
                        b'data: {"id":"test","object":"chat.completion.chunk",'
                        b'"created":0,"model":"test-model","choices":[{"index":0,'
                        b'"delta":{"content":"Ready"},"finish_reason":null}]}\n\n'
                        b'data: [DONE]\n\n'
                    )
                    content_type = "text/event-stream"
                if status != 200:
                    payload = b'{"error":{"message":"SECRET-provider-body","type":"test"}}'
                    content_type = "application/json"
                writer.write(
                    f"HTTP/1.1 {status} Test\r\nContent-Type: {content_type}\r\n"
                    f"Content-Length: {len(payload)}\r\nConnection: keep-alive\r\n\r\n".encode()
                    + payload
                )
                await writer.drain()
        except (asyncio.IncompleteReadError, ConnectionError):
            pass
        finally:
            writer.close()
            await writer.wait_closed()
            handlers.discard(asyncio.current_task())

    server = await asyncio.start_server(handle, "127.0.0.1", 0)
    port = server.sockets[0].getsockname()[1]
    try:
        yield f"http://127.0.0.1:{port}/v1", requests, received, release
    finally:
        server.close()
        pending = list(handlers)
        for task in pending:
            task.cancel()
        await asyncio.gather(*pending, return_exceptions=True)
        await server.wait_closed()


def _loopback_service(url, *, preconnect=True):
    return OpenAILLMService(
        api_key="test-key", base_url=url, preconnect=preconnect,
        enable_direct_mode=True,
        settings=OpenAILLMService.Settings(model="test-model", system_instruction="Rules."),
    )


async def _start_service(service):
    # Real public queue_frame dispatches the installed on_after_process_frame hook.
    await service.setup(FrameProcessorSetup(
        clock=SystemClock(), task_manager=TaskManager(), pipeline_worker=None,
    ))
    await asyncio.wait_for(service.queue_frame(StartFrame()), timeout=0.5)


async def _complete(service):
    stream = await service.get_chat_completions(LLMContext(
        messages=[{"role": "user", "content": "Private caller text."}],
    ))
    try:
        return [chunk async for chunk in stream]
    finally:
        await stream.close()


@pytest.mark.parametrize("frame_type", [StartFrame, InterruptionFrame])
def test_preconnect_metadata_then_completion_reuses_same_tcp_connection(frame_type):
    async def scenario():
        async with _http1_server() as (url, requests, received, _):
            service = _loopback_service(url)
            try:
                await _start_service(service)
                await asyncio.wait_for(received.get(), 0.5)
                await asyncio.wait_for(service._preconnect_task, 0.5)
                if frame_type is InterruptionFrame:
                    await service._update_settings(service.Settings(model="fallback-model"))
                    await asyncio.wait_for(service.queue_frame(InterruptionFrame()), 0.5)
                    await asyncio.wait_for(received.get(), 0.5)
                    await asyncio.wait_for(service._preconnect_task, 0.5)
                chunks = await _complete(service)
                assert chunks[0].choices[0].delta.content == "Ready"
                metadata, completion = requests[-2:]
                model = "fallback-model" if frame_type is InterruptionFrame else "test-model"
                assert metadata["method"] == "GET"
                assert metadata["path"] == f"/v1/models/{model}"
                assert metadata["body"] == b""
                assert metadata["version"] == completion["version"] == "HTTP/1.1"
                assert metadata["peer"] == completion["peer"]
                assert metadata["headers"]["authorization"] == "Bearer test-key"
                assert completion["path"] == "/v1/chat/completions"
                assert json.loads(completion["body"])["messages"][-1]["content"] == "Private caller text."
                # Only explicit inference is a POST, with no leaked custom SDK flag.
                assert sum(r["method"] == "POST" for r in requests) == 1
                assert "preconnect" not in json.loads(completion["body"])
            finally:
                await service.cleanup()

    asyncio.run(scenario())


def test_pending_metadata_does_not_gate_completion_and_deduplicates_frames():
    async def scenario():
        async with _http1_server(block_metadata=True) as (url, requests, received, _):
            service = _loopback_service(url)
            try:
                await _start_service(service)
                await asyncio.wait_for(received.get(), 0.5)
                warmup = service._preconnect_task
                for _ in range(10):
                    await asyncio.wait_for(service.queue_frame(InterruptionFrame()), 0.2)
                await service.queue_frame(TextFrame("ignored by preconnect"))
                assert service._preconnect_task is warmup
                assert not warmup.done()
                chunks = await asyncio.wait_for(_complete(service), 0.5)
                assert chunks[0].choices[0].delta.content == "Ready"
                assert not warmup.done()
                assert [r["method"] for r in requests] == ["GET", "POST"]
            finally:
                await service.cleanup()

    asyncio.run(scenario())


@pytest.mark.parametrize("failure", ["status", "timeout"])
def test_metadata_failure_is_bounded_without_retry_or_inference_fallback(failure):
    async def scenario():
        messages = []
        sink = logger.add(lambda message: messages.append(str(message)), level="DEBUG",
                          filter="voice_receptionist_worker.pipeline.openai_llm")
        try:
            async with _http1_server(
                metadata_status=503, block_metadata=failure == "timeout",
            ) as (url, requests, received, _):
                service = _loopback_service(url)
                try:
                    await _start_service(service)
                    await asyncio.wait_for(received.get(), 0.5)
                    warmup = service._preconnect_task
                    # A stalled GET must finish at the requested 0.8s timeout.
                    await asyncio.wait_for(asyncio.shield(warmup), 1.3)
                    assert not warmup.cancelled()
                    assert warmup.exception() is None
                    assert [r["method"] for r in requests] == ["GET"]
                    assert requests[0]["headers"]["x-stainless-retry-count"] == "0"
                    assert service.is_usable
                    assert messages and "SECRET-provider-body" not in "".join(messages)
                    assert "test-key" not in "".join(messages)
                    assert (await _complete(service))[0].choices[0].delta.content == "Ready"
                    assert [r["method"] for r in requests] == ["GET", "POST"]
                finally:
                    await service.cleanup()
        finally:
            logger.remove(sink)

    asyncio.run(scenario())


@pytest.mark.parametrize("error_type", [None, RuntimeError, asyncio.CancelledError])
def test_cleanup_joins_pending_warmup_before_client_close_even_if_parent_fails(monkeypatch, error_type):
    from pipecat.services.openai.llm import OpenAILLMService as PipecatOpenAILLMService

    async def scenario():
        async with _http1_server(block_metadata=True) as (url, requests, received, _):
            service = _loopback_service(url)
            await _start_service(service)
            await asyncio.wait_for(received.get(), 0.5)
            warmup = service._preconnect_task
            original_close = service._client.close
            parent_cleanup = PipecatOpenAILLMService.cleanup

            async def close_after_join():
                assert warmup.done() and warmup.cancelled()
                await original_close()

            async def failing_parent(self):
                await parent_cleanup(self)
                raise error_type()

            monkeypatch.setattr(service._client, "close", close_after_join)
            if error_type:
                monkeypatch.setattr(PipecatOpenAILLMService, "cleanup", failing_parent)
            try:
                if error_type:
                    with pytest.raises(error_type):
                        await service.cleanup()
                else:
                    await service.cleanup()
                    await service.cleanup()
                assert service._client.is_closed()
                # Even a late public hook cannot restart work after cleanup.
                await service._call_event_handler("on_after_process_frame", InterruptionFrame())
                await asyncio.sleep(0)
                assert len(requests) == 1
            finally:
                await original_close()

    asyncio.run(scenario())


@pytest.mark.parametrize("flag", [None, False, True])
def test_factory_preconnect_is_opt_in(providers, monkeypatch, flag):
    async def scenario():
        async with _http1_server() as (url, requests, received, _):
            monkeypatch.setenv("OPENAI_BASE_URL", url)
            if flag is not None:
                providers["voice_llm"]["preconnect"] = flag
            service = _create_voice_llm(providers, "Rules.")
            try:
                await _start_service(service)
                if flag is True:
                    await asyncio.wait_for(received.get(), 0.5)
                    await asyncio.wait_for(service._preconnect_task, 0.5)
                await _complete(service)
                assert [r["method"] for r in requests] == (["GET", "POST"] if flag else ["POST"])
            finally:
                await service.cleanup()

    asyncio.run(scenario())


@pytest.mark.parametrize("flag", [None, 0, 1, "false", "true", [], {}])
def test_factory_and_constructor_reject_non_boolean_preconnect(providers, flag):
    providers["voice_llm"]["preconnect"] = flag
    with pytest.raises(ValueError, match="preconnect.*bool"):
        _create_voice_llm(providers, "Rules.")
    with pytest.raises(ValueError, match="preconnect.*bool"):
        OpenAILLMService(api_key="test-key", preconnect=flag)


@pytest.mark.parametrize("new_extra", [{}, {"service_tier": "priority"},
                                       {"reasoning_effort": "low", "service_tier": "auto"}])
def test_changed_model_omits_stale_extra_on_wire_without_mutating_delta(providers, monkeypatch, new_extra):
    async def scenario():
        async with _http1_server() as (url, requests, _, _):
            monkeypatch.setenv("OPENAI_BASE_URL", url)
            service = _create_voice_llm(providers, "Rules.")
            delta = service.Settings(model="fallback-model", extra=dict(new_extra))
            original_extra = delta.extra
            try:
                changed = await service._update_settings(delta)
                assert changed["model"] == "gpt-4.1-mini"
                assert delta.extra is original_extra and delta.extra == new_extra
                assert not is_given(delta.system_instruction)
                for key in {"reasoning_effort", "service_tier"} - new_extra.keys():
                    assert service._settings.extra[key] is OPENAI_NOT_GIVEN
                await _complete(service)
                payload = json.loads(requests[0]["body"])
                assert payload["model"] == "fallback-model"
                assert {key: payload[key] for key in ("reasoning_effort", "service_tier") if key in payload} == new_extra
                assert payload["messages"][0]["content"] == "Rules."
                assert payload["max_completion_tokens"] == 256
            finally:
                await service.cleanup()

    asyncio.run(scenario())


@pytest.mark.parametrize("update", ["language", "same_model", "same_model_extra"])
def test_language_and_same_model_changes_preserve_extra(providers, update):
    async def scenario():
        service = _create_voice_llm(providers, "Rules.")
        try:
            if update == "language":
                delta = _language_settings_factory(providers, "Rules.")("hi")
            else:
                delta = service.Settings(model="gpt-4.1-mini", extra=(
                    {"service_tier": "priority"} if update == "same_model_extra" else {}
                ))
            await service._update_settings(delta)
            assert service._settings.extra == {
                "reasoning_effort": "none",
                "service_tier": "priority" if update == "same_model_extra" else "default",
            }
        finally:
            await service.cleanup()

    asyncio.run(scenario())


def test_preconnect_does_not_suppress_actual_inference_errors():
    async def scenario():
        async with _http1_server(completion_status=400) as (url, requests, received, _):
            service = _loopback_service(url)
            try:
                await _start_service(service)
                await asyncio.wait_for(received.get(), 0.5)
                await asyncio.wait_for(service._preconnect_task, 0.5)
                with pytest.raises(BadRequestError):
                    await _complete(service)
                assert [r["method"] for r in requests] == ["GET", "POST"]
            finally:
                await service.cleanup()

    asyncio.run(scenario())
