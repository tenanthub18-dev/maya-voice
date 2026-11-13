from __future__ import annotations

import asyncio
import os
from collections.abc import Mapping
from typing import Any

from voice_receptionist_worker.tools import (
    ToolContext,
    ToolDispatcher,
    build_tool_schemas,
    pipecat_handler,
)
from voice_receptionist_worker.resilience import CallBehaviour, FailurePolicy, NoisePolicy
from voice_receptionist_worker.resilience.policy import Action, ActionKind
from voice_receptionist_worker.security.redaction import redacted_logger

from .config import ProviderConfigError, RuntimeConfig
from .ack import AckPlayer, make_probe
from .latency import create_latency_observer
from .prompt import build_greeting, build_system_prompt
from .spoken_numbers import tts_text_transform


logger = redacted_logger(__name__)


def _stream_value(stream_info: object, *names: str) -> str:
    for name in names:
        value = (
            stream_info.get(name)
            if isinstance(stream_info, Mapping)
            else getattr(stream_info, name, None)
        )
        if value:
            return str(value)
    raise ProviderConfigError(
        f"VERIFY provider config: missing Telnyx stream field {names[0]}"
    )


def _optional_stream_value(stream_info: object, *names: str) -> str | None:
    for name in names:
        value = (
            stream_info.get(name)
            if isinstance(stream_info, Mapping)
            else getattr(stream_info, name, None)
        )
        if value:
            return str(value)
    return None


def _require_env(name: str) -> str:
    value = os.environ.get(name)
    if not value:
        raise ProviderConfigError(
            f"VERIFY provider config: missing environment variable {name}"
        )
    return value


def _google_llm_settings(llm_config: Mapping[str, Any], system_instruction: str):
    from pipecat.services.google.llm import GoogleLLMService

    # Installed Pipecat 1.14.0 supports `thinking` with `thinking_level` here:
    # apps/worker/.venv/lib/python3.12/site-packages/pipecat/services/google/llm.py
    # Gemini generation parameters:
    # https://ai.google.dev/api/generate-content#generationconfig
    return GoogleLLMService.Settings(
        model=llm_config["model"],
        system_instruction=system_instruction,
        max_tokens=llm_config["max_output_tokens"],
        thinking=GoogleLLMService.ThinkingConfig(thinking_level="minimal"),
    )


def _voice_llm_config(providers: Mapping[str, Any]) -> Mapping[str, Any]:
    """In-call LLM: `voice_llm` when set, else the shared `llm` block (also used post-call)."""
    config = dict(providers.get("voice_llm") or providers["llm"])
    # Per-run overrides for latency experiments (model name, reasoning effort; empty effort = not sent).
    if os.environ.get("VOICE_LLM_MODEL"):
        config["model"] = os.environ["VOICE_LLM_MODEL"]
    if "VOICE_LLM_REASONING" in os.environ:
        config["reasoning_effort"] = os.environ["VOICE_LLM_REASONING"] or None
    return config


def _create_voice_llm(providers: Mapping[str, Any], system_instruction: str):
    config = _voice_llm_config(providers)
    if config["provider"] == "openai":
        # Installed Pipecat 1.14.0: pipecat/services/openai/base_llm.py (Settings.extra is passed
        # to chat.completions). reasoning_effort: https://platform.openai.com/docs/api-reference/chat/create
        from pipecat.services.openai.llm import OpenAILLMService

        return OpenAILLMService(
            api_key=_require_env("OPENAI_API_KEY"),
            settings=OpenAILLMService.Settings(
                model=config["model"],
                system_instruction=system_instruction,
                max_completion_tokens=config["max_output_tokens"],
                extra={
                    **({"reasoning_effort": config["reasoning_effort"]} if config.get("reasoning_effort") else {}),
                    **({"service_tier": config["service_tier"]} if config.get("service_tier") else {}),
                },
            ),
        )
    from pipecat.services.google.llm import GoogleLLMService

    return GoogleLLMService(
        api_key=_require_env("GEMINI_API_KEY"),
        settings=_google_llm_settings(config, system_instruction),
    )


def _language_settings_factory(providers: Mapping[str, Any], base: str):
    # Typed Settings deltas replace the instruction without growing LLMContext.
    # https://github.com/pipecat-ai/pipecat/blob/v1.14.0/src/pipecat/services/settings.py
    if _voice_llm_config(providers)["provider"] == "openai":
        from pipecat.services.openai.llm import OpenAILLMService
        settings = OpenAILLMService.Settings
    else:
        from pipecat.services.google.llm import GoogleLLMService
        settings = GoogleLLMService.Settings
    return lambda code: settings(system_instruction=(
        f"{base}\ncaller_language: {code}\n"
        "Reply in this language while preserving menu names and natural English mixing."
    ))


def _browser_languages(config: RuntimeConfig) -> tuple[set[str], str]:
    launch = set(config.providers["resilience"]["launch_languages"])
    bases = {code.split("-")[0] for code in launch}
    enabled = set(config.restaurant.get("enabled_languages", launch))
    primary = config.restaurant.get("primary_language") or "en"
    supported = {code for code in enabled | {primary}
                 if code in launch or (code == "en-IN" and "en" in bases)}
    if not supported:
        raise ProviderConfigError("Restaurant has no supported browser language")
    return supported, primary if primary in supported else ("en" if "en" in supported else sorted(supported)[0])


def _voice_llm_fallback_model(providers: Mapping[str, Any]) -> str | None:
    fallback = providers.get("voice_llm_fallback") or providers.get("llm_fallback") or {}
    return fallback.get("model")


def create_tool_context(
    params: Any,
    *,
    call_id: str,
    restaurant_id: str,
    language: str = "en",
    caller_phone: str | None = None,
    dry_run: bool = False,
) -> ToolContext:
    """Map Pipecat's stable tool-call identifier to our idempotent turn key."""
    return ToolContext(
        call_id=call_id,
        turn=str(params.tool_call_id),
        restaurant_id=restaurant_id,
        language=language,
        caller_phone=caller_phone,
        dry_run=dry_run,
    )


def build_pipeline(
    config: RuntimeConfig,
    websocket: Any,
    stream_info: object,
    *,
    tool_dispatcher: ToolDispatcher | None = None,
    database_call_id: str | None = None,
    dry_run_tools: bool = False,
    prompt_sections: Mapping[str, str] | None = None,
):
    """Build a streaming Telnyx → Soniox → Gemini → Soniox worker.

    Constructor and pipeline shapes follow Pipecat's official references:
    https://docs.pipecat.ai/pipecat/telephony/telnyx-websockets
    https://docs.pipecat.ai/api-reference/server/services/stt/soniox
    https://docs.pipecat.ai/api-reference/server/services/llm/google
    https://docs.pipecat.ai/api-reference/server/services/tts/soniox
    """
    from pipecat.audio.vad.silero import SileroVADAnalyzer
    from pipecat.audio.vad.vad_analyzer import VADParams
    from pipecat.pipeline.pipeline import Pipeline
    from pipecat.pipeline.worker import (
        PipelineParams,
        PipelineWorker,
        ProcessorUnusablePolicy,
    )
    from pipecat.frames.frames import (
        EndFrame,
        InterruptionFrame,
        LLMRunFrame,
        LLMUpdateSettingsFrame,
        StopFrame,
        TTSSpeakFrame,
        TTSUpdateSettingsFrame,
    )
    from pipecat.processors.aggregators.llm_context import LLMContext
    from pipecat.processors.aggregators.llm_response_universal import (
        LLMContextAggregatorPair,
        LLMUserAggregatorParams,
    )
    from pipecat.serializers.telnyx import TelnyxFrameSerializer
    from pipecat.services.soniox.stt import SonioxSTTService
    from pipecat.services.soniox.tts import SonioxTTSService
    from pipecat.transports.websocket.fastapi import (
        FastAPIWebsocketParams,
        FastAPIWebsocketTransport,
    )
    # Barge-in needs 3 recognised words while the bot talks, so speaker echo and room noise do not cut her off.
    # Installed Pipecat 1.14.0: pipecat/turns/user_start/min_words_user_turn_start_strategy.py
    from pipecat.turns.user_start.min_words_user_turn_start_strategy import (
        MinWordsUserTurnStartStrategy,
    )
    from pipecat.turns.user_turn_strategies import UserTurnStrategies
    from voice_receptionist_worker.resilience.runtime import (
        DTMFTransferProcessor,
        FalseBargeInProcessor,
        LanguageSwitchProcessor,
        TTSLanguageProcessor,
        TTSRetryProcessor,
        wire_resilience,
    )

    providers = config.providers
    expected_providers = {
        "stt": "soniox",
        "tts": "soniox",
        "telephony": "telnyx",
    }
    mismatches = [
        name
        for name, expected in expected_providers.items()
        if providers[name]["provider"] != expected
    ]
    if _voice_llm_config(providers)["provider"] not in {"google", "openai"}:
        mismatches.append("llm")
    if mismatches:
        raise ProviderConfigError(
            f"VERIFY provider config: unsupported providers {', '.join(mismatches)}"
        )

    soniox_api_key = _require_env("SONIOX_API_KEY")
    telnyx_api_key = _require_env("TELNYX_API_KEY")
    latency_path = _require_env("LATENCY_JSONL_PATH")
    call_id = _stream_value(stream_info, "call_id", "call_control_id")
    caller_phone = _optional_stream_value(stream_info, "from", "caller_id", "from_number")

    serializer = TelnyxFrameSerializer(
        stream_id=_stream_value(stream_info, "stream_id"),
        call_control_id=call_id,
        outbound_encoding=_stream_value(stream_info, "outbound_encoding"),
        inbound_encoding="PCMU",
        api_key=telnyx_api_key,
    )
    transport = FastAPIWebsocketTransport(
        websocket=websocket,
        params=FastAPIWebsocketParams(
            audio_in_enabled=True,
            audio_out_enabled=True,
            add_wav_header=False,
            serializer=serializer,
        ),
    )

    noise_config = providers["resilience"]["noise"]
    vad = SileroVADAnalyzer(
        params=VADParams(
            confidence=float(noise_config["base_vad_threshold"]),
            stop_secs=float(os.environ.get("VAD_STOP_SECS", "0.12")),
        )
    )
    stt = SonioxSTTService(
        api_key=soniox_api_key,
        settings=SonioxSTTService.Settings(
            model=providers["stt"]["model"],
            enable_language_identification=True,
            language_hints=_stt_language_hints(providers),
            # https://docs.soniox.com/stt/concepts/language-restrictions
            language_hints_strict=True,
        ),
    )
    system_prompt = _system_prompt_with_sections(config.restaurant, prompt_sections)
    llm = _create_voice_llm(providers, system_prompt)
    tts = SonioxTTSService(
        api_key=soniox_api_key,
        settings=SonioxTTSService.Settings(
            model=providers["tts"]["model"],
            voice=providers["tts"]["voice"],
        ),
        text_aggregation_mode=_tts_aggregation_mode(),
        text_transforms=[("*", tts_text_transform)],
    )
    tts_connected = asyncio.Event()

    @tts.event_handler("on_connected")
    async def on_tts_connected(service) -> None:
        tts_connected.set()
    behaviour = CallBehaviour(
        wrap_up_seconds=float(providers["resilience"]["wrap_up_seconds"]),
        hard_end_seconds=float(providers["resilience"]["hard_end_seconds"]),
        silence_check_seconds=float(providers["resilience"]["silence_check_seconds"]),
        silence_end_seconds=float(providers["resilience"]["silence_end_seconds"]),
    )
    tts_fallback = providers.get("tts_fallback")
    verified_tts_fallback = (
        {"model": tts_fallback["model"], "voice": tts_fallback["voice"]}
        if isinstance(tts_fallback, Mapping)
        and tts_fallback.get("provider") == "soniox"
        and tts_fallback.get("model")
        and tts_fallback.get("voice")
        else None
    )
    if tts_fallback and not verified_tts_fallback:
        logger.warning("Unsupported tts_fallback config; cached transfer fallback will be used")
    failure_policy = FailurePolicy(
        verified_tts_fallback,
        _voice_llm_fallback_model(providers),
    )
    phrases = providers["resilience"]["cached_phrases"]
    language = "en"
    worker_ref: dict[str, Any] = {}
    transfer_requested = False
    tts_retry_processor = TTSRetryProcessor()

    async def emit_resilience_actions(actions) -> None:
        nonlocal language, transfer_requested
        worker = worker_ref.get("worker")
        if worker is None:
            return
        for action in actions:
            if action.kind == ActionKind.PLAY_CACHED and action.phrase:
                await worker.queue_frame(
                    TTSSpeakFrame(
                        text=phrases[action.phrase][language],
                        append_to_context=False,
                    )
                )
            elif action.kind == ActionKind.RECONNECT_STT:
                # Verified installed replay path: STTService._request_reconnect/
                # _reconnect in pipecat/services/stt_service.py buffers audio
                # received while reconnecting and replays it after connection.
                try:
                    async with asyncio.timeout(action.data["deadline_seconds"]):
                        await stt._request_reconnect()
                except TimeoutError:
                    await emit_resilience_actions(failure_policy.stt_failed(b""))
            elif action.kind == ActionKind.USE_FALLBACK_TTS:
                await worker.queue_frame(TTSUpdateSettingsFrame(settings=action.data["config"]))
            elif action.kind == ActionKind.RETRY_TTS:
                tts_connected.clear()

                async def retry_when_reconnected() -> None:
                    try:
                        async with asyncio.timeout(1.0):
                            await tts_connected.wait()
                        if not await tts_retry_processor.retry():
                            raise RuntimeError("no TTS input available to retry")
                    except (TimeoutError, RuntimeError):
                        await emit_resilience_actions(failure_policy.tts_failed())

                asyncio.create_task(retry_when_reconnected())
            elif action.kind == ActionKind.RETRY_LLM:
                await worker.queue_frames(
                    [
                        InterruptionFrame(),
                        LLMUpdateSettingsFrame(settings={"model": action.data["model"]}),
                        LLMRunFrame(),
                    ]
                )
            elif action.kind == ActionKind.SWITCH_LANGUAGE:
                language = action.data["language"]
                await worker.queue_frame(
                    LLMUpdateSettingsFrame(
                        settings={
                            "system_instruction": (
                                f"{system_prompt} The caller's current language is {language}; "
                                "reply in that language while preserving menu item names."
                            )
                        }
                    )
                )
            elif action.kind in {
                ActionKind.SAY_TOOL_FAILED,
                ActionKind.CHECK_SILENCE,
                ActionKind.WRAP_UP,
                ActionKind.ASK_PHONE,
                ActionKind.OFFER_SUPPORTED_LANGUAGE,
                ActionKind.DISCLOSE_AI,
                ActionKind.WARN_ABUSE,
                ActionKind.REDIRECT_RESTAURANT,
            }:
                spoken = {
                    ActionKind.SAY_TOOL_FAILED: "Sorry, I could not complete that step.",
                    ActionKind.CHECK_SILENCE: "Are you still there?",
                    ActionKind.WRAP_UP: "Before we finish, is there one last restaurant question I can help with?",
                    ActionKind.ASK_PHONE: "What phone number should we use for confirmation?",
                    ActionKind.OFFER_SUPPORTED_LANGUAGE: "Sorry, I can continue in English or French, or transfer you.",
                    ActionKind.DISCLOSE_AI: "I'm the restaurant's AI assistant.",
                    ActionKind.WARN_ABUSE: "I can help with the restaurant, but I need us to keep the conversation respectful.",
                    ActionKind.REDIRECT_RESTAURANT: "I can only help with this restaurant's menu, hours, bookings, and orders.",
                }[action.kind]
                await worker.queue_frame(TTSSpeakFrame(text=spoken, append_to_context=False))
            elif action.kind == ActionKind.TRANSFER:
                transfer_requested = True
                await websocket.close(code=1000, reason="transfer requested")
            elif action.kind == ActionKind.END_CALL:
                await worker.queue_frame(EndFrame(reason="call policy ended call"))

    dtmf_processor = DTMFTransferProcessor(behaviour, emit_resilience_actions)
    noise_policy = NoisePolicy(
        int(noise_config["false_barge_in_limit"]),
        float(noise_config["window_seconds"]),
        float(noise_config["base_vad_threshold"]),
        float(noise_config["raised_vad_threshold"]),
    )

    def update_vad_threshold(threshold: float) -> None:
        # VADAnalyzer.set_params is the installed Pipecat 1.14.0 runtime update
        # contract: pipecat/audio/vad/vad_analyzer.py.
        vad.set_params(vad.params.model_copy(update={"confidence": threshold}))

    noise_processor = FalseBargeInProcessor(noise_policy, update_vad_threshold)
    language_processor = LanguageSwitchProcessor(
        behaviour,
        set(providers["resilience"]["launch_languages"]),
        emit_resilience_actions,
    )

    tool_schemas = build_tool_schemas() if tool_dispatcher else None
    context = LLMContext(tools=tool_schemas) if tool_schemas else LLMContext()
    if tool_dispatcher:
        restaurant_id = config.restaurant.get("id")
        if not restaurant_id:
            raise ProviderConfigError(
                "Restaurant config requires id when agent tools are enabled"
            )
        if not database_call_id:
            raise ProviderConfigError(
                "Database call id is required when agent tools are enabled"
            )
        async def handle_tool_result(name: str, result: dict[str, Any]) -> None:
            error_code = result.get("error", {}).get("code")
            if error_code == "timeout":
                await emit_resilience_actions(failure_policy.tool_timed_out())
            elif error_code == "faq_only":
                await emit_resilience_actions(failure_policy.supabase_unreachable())
            elif name == "transfer_call" and result.get("ok"):
                await emit_resilience_actions([Action(ActionKind.TRANSFER)])
            elif name == "end_call" and result.get("ok"):
                await emit_resilience_actions(
                    [
                        Action(ActionKind.PLAY_CACHED, phrase="goodbye"),
                        Action(ActionKind.END_CALL),
                    ]
                )

        handler = pipecat_handler(
            tool_dispatcher,
            lambda params: create_tool_context(
                params,
                call_id=database_call_id,
                restaurant_id=str(restaurant_id),
                caller_phone=caller_phone,
                dry_run=dry_run_tools,
            ),
            handle_tool_result,
        )
        # Installed Pipecat 1.14.0 registration contract:
        # apps/worker/.venv/lib/python3.12/site-packages/pipecat/services/llm_service.py
        # https://docs.pipecat.ai/guides/features/llm-functions
        for schema in tool_schemas.standard_tools:
            llm.register_function(
                schema.name,
                handler,
                timeout_secs=tool_dispatcher.timeout_seconds,
            )
    user_aggregator, assistant_aggregator = LLMContextAggregatorPair(
        context,
        user_params=LLMUserAggregatorParams(
            vad_analyzer=vad,
            user_turn_strategies=UserTurnStrategies(
                start=[MinWordsUserTurnStartStrategy(min_words=3)],
                stop=[_user_turn_stop_strategy()],
            ),
        ),
    )
    ack_player, ack_probe = _maybe_ack(
        providers, soniox_api_key, user_aggregator, tts, transport.output(), latency_path, call_id
    )
    pipeline = Pipeline(
        [
            transport.input(),
            dtmf_processor,
            noise_processor,
            stt,
            language_processor,
            TTSLanguageProcessor(
                set(providers["resilience"]["launch_languages"]),
                ack_player.set_language if ack_player else None,
            ),
            user_aggregator,
            llm,
            tts_retry_processor,
            tts,
            *([ack_probe] if ack_probe else []),
            transport.output(),
            assistant_aggregator,
        ]
    )
    worker = PipelineWorker(
        pipeline,
        params=PipelineParams(enable_metrics=True),
        observers=[create_latency_observer(latency_path, call_id=call_id)],
        processor_unusable_policy=ProcessorUnusablePolicy.CONTINUE,
        idle_timeout_secs=float(providers["resilience"]["silence_check_seconds"]),
        cancel_on_idle_timeout=False,
    )
    worker_ref["worker"] = worker
    wire_resilience(
        worker=worker,
        stt=stt,
        tts=tts,
        llm=llm,
        policy=failure_policy,
        behaviour=behaviour,
        emit=emit_resilience_actions,
        wrap_up_seconds=float(providers["resilience"]["wrap_up_seconds"]),
        hard_end_seconds=float(providers["resilience"]["hard_end_seconds"]),
        silence_step_seconds=float(providers["resilience"]["silence_check_seconds"]),
        first_token_timeout_seconds=float(
            providers["resilience"]["llm_first_token_timeout_seconds"]
        ),
    )

    @worker.event_handler("on_pipeline_started")
    async def preload_ack(worker, frame) -> None:
        if ack_player:
            ack_player.preload()

    @worker.event_handler("on_pipeline_started")
    async def announce_private_caller(worker, frame) -> None:
        await emit_resilience_actions(behaviour.caller_id(caller_phone))

    @worker.event_handler("on_pipeline_started")
    async def speak_greeting(worker, frame) -> None:
        await worker.queue_frame(
            TTSSpeakFrame(
                text=build_greeting(config.restaurant, prompt_sections),
                append_to_context=False,
            )
        )

    @transport.event_handler("on_client_disconnected")
    async def on_client_disconnected(transport, client) -> None:
        if transfer_requested:
            # StopFrame finishes Pipecat without TelnyxFrameSerializer's
            # EndFrame/CancelFrame auto-hangup, allowing the following TeXML
            # Say/Dial verbs to run after Connect ends.
            await worker.queue_frame(StopFrame())
        else:
            await worker.cancel(reason="Telnyx WebSocket disconnected")

    return worker


def _maybe_ack(providers, api_key, user_aggregator, tts, output, latency_path, call_id):
    """Pre-recorded acknowledgement at turn end (off by default; ACK_CLIPS=1 turns it on). Returns (player, probe) or (None, None)."""
    if os.environ.get("ACK_CLIPS", "0") != "1":
        return None, None
    player = AckPlayer(api_key, providers["tts"]["model"], providers["tts"]["voice"])

    @user_aggregator.event_handler("on_user_turn_stopped")
    async def play_ack(aggregator, strategy, message) -> None:
        await player.on_turn_stopped(output, tts.sample_rate)

    return player, make_probe(player, f"{latency_path}.content", call_id)


def _tts_aggregation_mode():
    """TOKEN streams LLM tokens straight into TTS (lower latency); SENTENCE waits for a full sentence."""
    from pipecat.services.tts_service import TextAggregationMode

    mode = os.environ.get("TTS_AGGREGATION", "sentence")
    if mode not in {"sentence", "token"}:
        raise ValueError(f"TTS_AGGREGATION must be sentence or token, got {mode!r}")
    return TextAggregationMode(mode)


def _user_turn_stop_strategy():
    """End-of-speech rule: fixed 0.25 s silence by default, or the local Smart Turn model.

    TURN_DETECTION=smart_turn uses the bundled smart-turn-v3.2 ONNX model.
    https://docs.pipecat.ai/server/utilities/smart-turn/smart-turn-overview
    """
    from pipecat.turns.user_stop.speech_timeout_user_turn_stop_strategy import (
        SpeechTimeoutUserTurnStopStrategy,
    )

    mode = os.environ.get("TURN_DETECTION", "speech_timeout")
    if mode == "smart_turn":
        from pipecat.audio.turn.smart_turn.local_smart_turn_v3 import LocalSmartTurnAnalyzerV3
        from pipecat.turns.user_stop.turn_analyzer_user_turn_stop_strategy import (
            TurnAnalyzerUserTurnStopStrategy,
        )

        return TurnAnalyzerUserTurnStopStrategy(turn_analyzer=LocalSmartTurnAnalyzerV3())
    if mode != "speech_timeout":
        raise ValueError(f"TURN_DETECTION must be speech_timeout or smart_turn, got {mode!r}")
    return SpeechTimeoutUserTurnStopStrategy(
        user_speech_timeout=float(os.environ.get("SPEECH_TIMEOUT_SECS", "0.1"))
    )


def _stt_language_hints(providers: Mapping[str, Any]) -> list[Any]:
    # Soniox language_hints bias language identification toward the launch
    # languages; Pipecat maps fr-CA to Soniox's "fr".
    # https://soniox.com/docs/stt/concepts/language-hints
    from pipecat.transcriptions.language import Language

    return [Language(code) for code in providers["resilience"]["launch_languages"]]


def _system_prompt_with_sections(
    restaurant: Mapping[str, Any],
    prompt_sections: Mapping[str, str] | None,
) -> str:
    from .prompt import build_runtime_context

    system_prompt = build_system_prompt(restaurant, include_runtime_context=False)
    if prompt_sections:
        drafted = "\n\n".join(
            f"[{name}]\n{content}" for name, content in sorted(prompt_sections.items())
        )
        system_prompt += f"\n\nOWNER DRAFT CONFIGURATION\n{drafted}"
    return system_prompt + build_runtime_context(restaurant)


async def run_pipeline(
    config: RuntimeConfig,
    websocket: Any,
    stream_info: object,
    *,
    tool_dispatcher: ToolDispatcher | None = None,
    database_call_id: str | None = None,
    dry_run_tools: bool = False,
    prompt_sections: Mapping[str, str] | None = None,
) -> None:
    from pipecat.workers.runner import WorkerRunner

    worker = build_pipeline(
        config,
        websocket,
        stream_info,
        tool_dispatcher=tool_dispatcher,
        database_call_id=database_call_id,
        dry_run_tools=dry_run_tools,
        prompt_sections=prompt_sections,
    )
    runner = WorkerRunner(handle_sigint=False)
    await runner.add_workers(worker)
    await runner.run()


def _browser_observers(latency_path, call_id, call_log, output, speech, *, speech_kind="tts"):
    observers = []
    if latency_path:
        latency = create_latency_observer(latency_path, call_id=call_id)
        if call_log:
            latency.add_event_handler("on_latency_breakdown", call_log.add_latency)
        observers.append(latency)
    if call_log:
        observers.extend(call_log.observers(output=output, speech=speech, speech_kind=speech_kind))
    return observers


def build_webrtc_pipeline(
    config: RuntimeConfig,
    webrtc_connection: Any,
    *,
    tool_dispatcher: ToolDispatcher,
    database_call_id: str,
    dry_run_tools: bool,
    prompt_sections: Mapping[str, str] | None = None,
    call_log: Any = None,
):
    """Build the browser test-call pipeline on Pipecat SmallWebRTC."""
    if os.environ.get("VOICE_MODE") == "realtime":
        return _build_webrtc_realtime_pipeline(
            config,
            webrtc_connection,
            tool_dispatcher=tool_dispatcher,
            database_call_id=database_call_id,
            dry_run_tools=dry_run_tools,
            prompt_sections=prompt_sections,
            call_log=call_log,
        )
    from pipecat.transports.base_transport import TransportParams
    from pipecat.transports.smallwebrtc.transport import SmallWebRTCTransport

    transport = SmallWebRTCTransport(
        webrtc_connection=webrtc_connection,
        params=TransportParams(audio_in_enabled=True, audio_out_enabled=True),
    )
    return _build_browser_cascade(
        config,
        transport,
        tool_dispatcher=tool_dispatcher,
        database_call_id=database_call_id,
        dry_run_tools=dry_run_tools,
        prompt_sections=prompt_sections,
        call_log=call_log,
    )


def build_browser_audio_pipeline(
    config: RuntimeConfig,
    websocket: Any,
    *,
    tool_dispatcher: ToolDispatcher,
    database_call_id: str,
    dry_run_tools: bool,
    prompt_sections: Mapping[str, str] | None = None,
    call_log: Any = None,
):
    """Attach browser PCM to the existing cascade after route authentication."""
    from pipecat.pipeline.worker import PipelineParams
    from pipecat.transports.websocket.fastapi import (
        FastAPIWebsocketParams,
        FastAPIWebsocketTransport,
    )
    from .browser_audio import BROWSER_SAMPLE_RATE, BrowserAudioSerializer

    # Pipecat 1.14.0: TransportParams and PipelineParams both set sample rates;
    # the latter otherwise defaults output to 24 kHz. No WAV/container on wire.
    # https://docs.pipecat.ai/api-reference/server/transports/websocket/fastapi
    async def queue_stop(frame) -> None:
        await worker.queue_frame(frame)

    transport = FastAPIWebsocketTransport(
        websocket=websocket,
        params=FastAPIWebsocketParams(
            audio_in_enabled=True,
            audio_out_enabled=True,
            audio_in_sample_rate=BROWSER_SAMPLE_RATE,
            audio_out_sample_rate=BROWSER_SAMPLE_RATE,
            audio_in_channels=1,
            audio_out_channels=1,
            add_wav_header=False,
            serializer=BrowserAudioSerializer(on_stop=queue_stop),
            session_timeout=600,
        ),
    )
    worker = _build_browser_cascade(
        config,
        transport,
        tool_dispatcher=tool_dispatcher,
        database_call_id=database_call_id,
        dry_run_tools=dry_run_tools,
        prompt_sections=prompt_sections,
        call_log=call_log,
        pipeline_params=PipelineParams(
            enable_metrics=True,
            enable_usage_metrics=True,
            audio_in_sample_rate=BROWSER_SAMPLE_RATE,
            audio_out_sample_rate=BROWSER_SAMPLE_RATE,
        ),
    )

    # session_timeout emits an event; it does not end the worker by itself.
    @transport.event_handler("on_session_timeout")
    async def on_session_timeout(transport, client) -> None:
        await worker.cancel(reason="Browser audio session timed out")

    return worker


def _build_browser_cascade(
    config: RuntimeConfig,
    transport: Any,
    *,
    tool_dispatcher: ToolDispatcher,
    database_call_id: str,
    dry_run_tools: bool,
    prompt_sections: Mapping[str, str] | None = None,
    call_log: Any = None,
    pipeline_params: Any = None,
):
    """Shared browser STT/language/LLM/TTS cascade, independent of audio transport."""
    from pipecat.audio.vad.silero import SileroVADAnalyzer
    from .greeting_cache import BrowserGreeting
    from pipecat.pipeline.pipeline import Pipeline
    from pipecat.pipeline.worker import (
        PipelineParams,
        PipelineWorker,
        ProcessorUnusablePolicy,
    )
    from pipecat.processors.aggregators.llm_context import LLMContext
    from pipecat.processors.aggregators.llm_response_universal import (
        LLMContextAggregatorPair,
        LLMUserAggregatorParams,
    )
    from pipecat.transcriptions.language import Language
    from pipecat.services.soniox.stt import SonioxSTTService
    from pipecat.services.soniox.tts import SonioxTTSService
    # Barge-in needs 3 recognised words while the bot talks, so speaker echo and room noise do not cut her off.
    # Installed Pipecat 1.14.0: pipecat/turns/user_start/min_words_user_turn_start_strategy.py
    from pipecat.turns.user_start.min_words_user_turn_start_strategy import (
        MinWordsUserTurnStartStrategy,
    )
    from pipecat.turns.user_turn_strategies import UserTurnStrategies
    from pipecat.audio.vad.vad_analyzer import VADParams
    from voice_receptionist_worker.resilience.runtime import (
        TTSLanguageProcessor, bind_response_language, response_language_tts_class,
    )

    providers = config.providers
    mismatches = [
        name
        for name, expected in {"stt": "soniox", "tts": "soniox"}.items()
        if providers[name]["provider"] != expected
    ]
    if _voice_llm_config(providers)["provider"] not in {"google", "openai"}:
        mismatches.append("llm")
    if mismatches:
        raise ProviderConfigError(
            f"VERIFY provider config: unsupported providers {', '.join(mismatches)}"
        )

    supported_languages, language = _browser_languages(config)
    soniox_api_key = _require_env("SONIOX_API_KEY")
    latency_path = _require_env("LATENCY_JSONL_PATH")
    vad = SileroVADAnalyzer(params=VADParams(stop_secs=float(os.environ.get("VAD_STOP_SECS", "0.12"))))
    stt = SonioxSTTService(
        api_key=soniox_api_key,
        settings=SonioxSTTService.Settings(
            model=providers["stt"]["model"],
            enable_language_identification=True,
            language_hints=[Language(code)
                            for code in sorted(supported_languages)],
            # https://docs.soniox.com/stt/concepts/language-restrictions
            language_hints_strict=True,
        ),
    )
    system_instruction = _system_prompt_with_sections(
        config.restaurant, prompt_sections
    )
    llm = _create_voice_llm(providers, system_instruction)
    bind_response_language(llm, initial_language=language)
    tts = response_language_tts_class()(
        api_key=soniox_api_key,
        initial_language=language,
        settings=SonioxTTSService.Settings(
            model=providers["tts"]["model"],
            voice=providers["tts"]["voice"],
            language=Language(language.split("-")[0]),
        ),
        text_aggregation_mode=_tts_aggregation_mode(),
        text_transforms=[("*", tts_text_transform)],
    )

    tool_schemas = build_tool_schemas()
    context = LLMContext(tools=tool_schemas)
    restaurant_id = config.restaurant.get("id")
    if not restaurant_id:
        raise ProviderConfigError("Restaurant config requires id for browser test calls")
    handler = pipecat_handler(
        tool_dispatcher,
        lambda params: create_tool_context(
            params,
            call_id=database_call_id,
            restaurant_id=str(restaurant_id),
            dry_run=True,
            language=language,
        ),
    )
    for schema in tool_schemas.standard_tools:
        llm.register_function(
            schema.name,
            handler,
            timeout_secs=tool_dispatcher.timeout_seconds,
        )

    user_aggregator, assistant_aggregator = LLMContextAggregatorPair(
        context,
        user_params=LLMUserAggregatorParams(
            vad_analyzer=vad,
            user_turn_strategies=UserTurnStrategies(
                start=[MinWordsUserTurnStartStrategy(min_words=3)],
                stop=[_user_turn_stop_strategy()],
            ),
        ),
    )
    ack_player, ack_probe = _maybe_ack(
        providers, soniox_api_key, user_aggregator, tts, transport.output(), latency_path, database_call_id
    )
    def language_changed(code: str) -> None:
        nonlocal language
        language = code
        if ack_player:
            ack_player.set_language(code)
        if call_log:
            call_log.language = code
            call_log.assistant_language = code
            call_log.languages.add(code)
            call_log.changed.set()

    language_changed(language)
    pipeline = Pipeline(
        [
            transport.input(),
            stt,
            TTSLanguageProcessor(
                supported_languages, language_changed,
                initial_language=language,
                llm_settings_factory=_language_settings_factory(providers, system_instruction),
            ),
            user_aggregator,
            llm,
            tts,
            *([ack_probe] if ack_probe else []),
            transport.output(),
            assistant_aggregator,
        ]
    )
    worker = PipelineWorker(
        pipeline,
        params=pipeline_params or PipelineParams(enable_metrics=True, enable_usage_metrics=True),
        observers=_browser_observers(latency_path, database_call_id, call_log, transport.output(), tts),
        processor_unusable_policy=ProcessorUnusablePolicy.END,
    )
    if call_log:
        call_log.bind_worker(worker)

    @worker.event_handler("on_pipeline_started")
    async def preload_ack(worker, frame) -> None:
        if ack_player:
            ack_player.preload()

    greeting = BrowserGreeting(config, prompt_sections, language=language)

    @worker.event_handler("on_pipeline_started")
    async def speak_greeting(worker, frame) -> None:
        await greeting.play(worker, transport.output(), worker.params.audio_out_sample_rate)

    @transport.event_handler("on_client_disconnected")
    async def on_client_disconnected(transport, client) -> None:
        await worker.cancel(reason="Browser test call disconnected")

    return worker


async def run_browser_audio_pipeline(
    config: RuntimeConfig,
    websocket: Any,
    *,
    tool_dispatcher: ToolDispatcher,
    database_call_id: str,
    dry_run_tools: bool,
    prompt_sections: Mapping[str, str] | None = None,
    call_log: Any = None,
) -> None:
    """Run a browser PCM session with the same WorkerRunner lifecycle as WebRTC."""
    from pipecat.workers.runner import WorkerRunner

    worker = build_browser_audio_pipeline(
        config,
        websocket,
        tool_dispatcher=tool_dispatcher,
        database_call_id=database_call_id,
        dry_run_tools=dry_run_tools,
        prompt_sections=prompt_sections,
        call_log=call_log,
    )
    runner = WorkerRunner(handle_sigint=False)
    await runner.add_workers(worker)
    await runner.run()


async def run_webrtc_pipeline(
    config: RuntimeConfig,
    webrtc_connection: Any,
    *,
    tool_dispatcher: ToolDispatcher,
    database_call_id: str,
    dry_run_tools: bool,
    prompt_sections: Mapping[str, str] | None = None,
    call_log: Any = None,
) -> None:
    from pipecat.workers.runner import WorkerRunner

    worker = build_webrtc_pipeline(
        config,
        webrtc_connection,
        tool_dispatcher=tool_dispatcher,
        database_call_id=database_call_id,
        dry_run_tools=dry_run_tools,
        prompt_sections=prompt_sections,
        call_log=call_log,
    )
    runner = WorkerRunner(handle_sigint=False)
    await runner.add_workers(worker)
    await runner.run()


_REALTIME_SPEECH_RULES = (
    " SPEAKING RULES FOR THIS SESSION (these override anything above about digits or tags): you speak aloud directly. "
    "Say every number (prices, times, dates, quantities, phone numbers) in English words even when the rest of the "
    "sentence is in another language, for example 'ten P M' or 'twenty-one ninety-five dollars'. "
    "Never say or spell bracketed tags, and never laugh or make filler sounds on purpose."
)


def _build_webrtc_realtime_pipeline(
    config: RuntimeConfig,
    webrtc_connection: Any,
    *,
    tool_dispatcher: ToolDispatcher,
    database_call_id: str,
    dry_run_tools: bool,
    prompt_sections: Mapping[str, str] | None = None,
    call_log: Any = None,
):
    """Experiment (VOICE_MODE=realtime): OpenAI speech-to-speech replaces STT -> LLM -> TTS.

    Pipecat contract: apps/worker/.venv/lib/python3.12/site-packages/pipecat/services/openai/realtime/
    Models: https://platform.openai.com/docs/guides/realtime
    """
    from pipecat.frames.frames import LLMRunFrame
    from pipecat.pipeline.pipeline import Pipeline
    from pipecat.pipeline.worker import PipelineParams, PipelineWorker, ProcessorUnusablePolicy
    from pipecat.processors.aggregators.llm_context import LLMContext
    from pipecat.processors.aggregators.llm_response_universal import LLMContextAggregatorPair
    from pipecat.services.openai.realtime import events
    from pipecat.services.openai.realtime.llm import OpenAIRealtimeLLMService
    from pipecat.transports.base_transport import TransportParams
    from pipecat.transports.smallwebrtc.transport import SmallWebRTCTransport

    restaurant_id = config.restaurant.get("id")
    if not restaurant_id:
        raise ProviderConfigError("Restaurant config requires id for browser test calls")
    instruction = _system_prompt_with_sections(config.restaurant, prompt_sections) + _REALTIME_SPEECH_RULES
    transport = SmallWebRTCTransport(
        webrtc_connection=webrtc_connection,
        params=TransportParams(audio_in_enabled=True, audio_out_enabled=True),
    )
    llm = OpenAIRealtimeLLMService(
        api_key=_require_env("OPENAI_API_KEY"),
        settings=OpenAIRealtimeLLMService.Settings(
            model=os.environ.get("REALTIME_MODEL", "gpt-realtime-2.1-mini"),
            system_instruction=instruction,
            session_properties=events.SessionProperties(
                output_modalities=["audio"],
                **(
                    {"reasoning": events.Reasoning(effort=os.environ["REALTIME_REASONING"])}
                    if os.environ.get("REALTIME_REASONING")
                    else {}
                ),
                audio=events.AudioConfiguration(
                    input=events.AudioInput(
                        turn_detection=(
                            events.TurnDetection(
                                silence_duration_ms=int(os.environ.get("REALTIME_SILENCE_MS", "200"))
                            )
                            if os.environ.get("REALTIME_VAD") == "server"
                            else events.SemanticTurnDetection(
                                eagerness=os.environ.get("REALTIME_EAGERNESS", "high")
                            )
                        )
                    ),
                    output=events.AudioOutput(voice=os.environ.get("REALTIME_VOICE", "marin")),
                ),
            ),
        ),
    )
    tool_schemas = build_tool_schemas()
    context = LLMContext(tools=tool_schemas)
    handler = pipecat_handler(
        tool_dispatcher,
        lambda params: create_tool_context(
            params, call_id=database_call_id, restaurant_id=str(restaurant_id), dry_run=True
        ),
    )
    for schema in tool_schemas.standard_tools:
        llm.register_function(schema.name, handler, timeout_secs=tool_dispatcher.timeout_seconds)
    user_aggregator, assistant_aggregator = LLMContextAggregatorPair(context)
    pipeline = Pipeline(
        [transport.input(), user_aggregator, llm, transport.output(), assistant_aggregator]
    )
    worker = PipelineWorker(
        pipeline,
        params=PipelineParams(enable_metrics=True, enable_usage_metrics=True),
        observers=_browser_observers(None, database_call_id, call_log, transport.output(), llm, speech_kind="llm"),
        processor_unusable_policy=ProcessorUnusablePolicy.END,
    )
    if call_log:
        call_log.bind_worker(worker)

    @worker.event_handler("on_pipeline_started")
    async def greet(worker, frame) -> None:
        context.add_message(
            {
                "role": "user",
                "content": "The caller just connected. Say this pickup greeting warmly: "
                + build_greeting(config.restaurant, prompt_sections),
            }
        )
        await worker.queue_frames([LLMRunFrame()])

    @transport.event_handler("on_client_disconnected")
    async def on_client_disconnected(transport, client) -> None:
        await worker.cancel(reason="Browser test call disconnected")

    return worker
