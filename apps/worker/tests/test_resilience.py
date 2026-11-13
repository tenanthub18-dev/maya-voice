from __future__ import annotations

import asyncio
import json
import warnings
from pathlib import Path

import yaml

warnings.filterwarnings("ignore", message="'audioop' is deprecated.*", category=DeprecationWarning)

from pipecat.audio.dtmf.types import KeypadEntry
from pipecat.frames.frames import (
    BotStartedSpeakingFrame,
    InputDTMFFrame,
    LLMRunFrame,
    LLMTextFrame,
    TTSSpeakFrame,
    TranscriptionFrame,
    UserStartedSpeakingFrame,
    UserStoppedSpeakingFrame,
)
from pipecat.processors.frame_processor import FrameDirection

from voice_receptionist_worker.pipeline.config import load_runtime_config
from voice_receptionist_worker.resilience.caller import CallBehaviour
from voice_receptionist_worker.resilience.noise import NoisePolicy
from voice_receptionist_worker.resilience.offline_queue import OfflineMessageQueue
from voice_receptionist_worker.resilience.policy import ActionKind, FailurePolicy
from voice_receptionist_worker.resilience.runtime import (
    DTMFTransferProcessor,
    FalseBargeInProcessor,
    LanguageSwitchProcessor,
    TTSRetryProcessor,
    wire_resilience,
)


LAUNCH_LANGUAGES = {"en", "fr-CA", "ur", "hi", "pa", "te", "ar"}


def kinds(actions):
    return [action.kind for action in actions]


def test_stt_failure_reconnects_then_speaks_and_transfers_without_silence() -> None:
    policy = FailurePolicy(tts_fallback=None, llm_fallback="fallback-model")
    first = policy.stt_failed(buffered_audio=b"audio")
    second = policy.stt_failed(buffered_audio=b"new-audio")

    assert kinds(first) == [ActionKind.RECONNECT_STT, ActionKind.REPLAY_AUDIO]
    assert first[0].data == {"deadline_seconds": 1.0}
    assert first[1].data == {"audio": b"audio"}
    assert kinds(second) == [ActionKind.PLAY_CACHED, ActionKind.TRANSFER]
    assert second[0].phrase == "trouble_hearing"


def test_tts_failure_retries_once_then_uses_configured_fallback_for_call() -> None:
    policy = FailurePolicy(
        tts_fallback={"provider": "verified", "model": "fallback", "voice": "v"},
        llm_fallback="fallback-model",
    )
    assert kinds(policy.tts_failed()) == [ActionKind.RETRY_TTS]
    actions = policy.tts_failed()

    assert kinds(actions) == [ActionKind.USE_FALLBACK_TTS]
    assert actions[0].data["for_rest_of_call"] is True
    assert policy.using_fallback_tts is True


def test_unset_tts_fallback_apologises_and_transfers_instead_of_silence(caplog) -> None:
    policy = FailurePolicy(tts_fallback=None, llm_fallback="fallback-model")
    policy.tts_failed()
    actions = policy.tts_failed()

    assert kinds(actions) == [ActionKind.PLAY_CACHED, ActionKind.TRANSFER]
    assert actions[0].phrase == "apology"
    assert "tts_fallback is not configured" in caplog.text


def test_llm_timeout_fills_then_falls_back_then_apologises_and_transfers() -> None:
    policy = FailurePolicy(tts_fallback=None, llm_fallback="fallback-model")
    first = policy.llm_first_token_timed_out(elapsed_seconds=2.51)
    second = policy.llm_first_token_timed_out(elapsed_seconds=2.51)

    assert kinds(first) == [ActionKind.PLAY_CACHED, ActionKind.RETRY_LLM]
    assert first[0].phrase == "filler"
    assert first[1].data == {"model": "fallback-model", "timeout_seconds": 2.5}
    assert kinds(second) == [ActionKind.PLAY_CACHED, ActionKind.TRANSFER]
    assert second[0].phrase == "apology"


def test_tool_database_and_billing_failures_have_a_spoken_or_transfer_path() -> None:
    policy = FailurePolicy(tts_fallback=None, llm_fallback="fallback-model")
    tool = policy.tool_timed_out()
    database = policy.supabase_unreachable()
    billing = policy.spend_cap_or_unpaid()

    assert kinds(tool) == [ActionKind.SAY_TOOL_FAILED]
    assert tool[0].data == {"claim_success": False, "timeout_seconds": 3.0}
    assert kinds(database) == [ActionKind.FAQ_ONLY, ActionKind.QUEUE_MESSAGES]
    assert kinds(billing) == [ActionKind.TRANSFER]


def test_call_limits_silence_dtmf_caller_id_language_and_disclosure() -> None:
    behaviour = CallBehaviour()
    assert kinds(behaviour.elapsed(539)) == []
    assert kinds(behaviour.elapsed(540)) == [ActionKind.WRAP_UP]
    assert kinds(behaviour.elapsed(600)) == [ActionKind.PLAY_CACHED, ActionKind.END_CALL]
    assert behaviour.elapsed(600) == []
    caller = CallBehaviour()
    assert kinds(caller.silence(8)) == [ActionKind.CHECK_SILENCE]
    assert kinds(caller.silence(16)) == [ActionKind.PLAY_CACHED, ActionKind.END_CALL]
    assert kinds(caller.dtmf("0")) == [ActionKind.PLAY_CACHED, ActionKind.TRANSFER]
    assert caller.dtmf("7") == []
    assert kinds(caller.caller_id("private")) == [ActionKind.ASK_PHONE]
    assert caller.caller_id("+14165550123") == []
    assert caller.language("ur", dominant_word_count=2, enabled={"en", "ur"}) == []
    assert kinds(caller.language("ur", dominant_word_count=3, enabled={"en", "ur"})) == [ActionKind.SWITCH_LANGUAGE]
    assert kinds(caller.language("zh", dominant_word_count=3, enabled={"en", "fr-CA"})) == [ActionKind.OFFER_SUPPORTED_LANGUAGE]
    assert caller.language("zh", dominant_word_count=4, enabled={"en", "fr-CA"}) == []
    assert kinds(caller.ai_disclosure_requested(True)) == [ActionKind.DISCLOSE_AI]


def test_abuse_warns_once_then_says_goodbye_and_flags_qa_and_off_topic_redirects() -> None:
    behaviour = CallBehaviour()
    assert kinds(behaviour.abuse()) == [ActionKind.WARN_ABUSE]
    assert kinds(behaviour.abuse()) == [ActionKind.QA_FLAG, ActionKind.PLAY_CACHED, ActionKind.END_CALL]
    assert kinds(behaviour.off_topic()) == [ActionKind.REDIRECT_RESTAURANT]


def test_noise_policy_raises_configured_vad_after_three_false_barge_ins() -> None:
    policy = NoisePolicy(3, 30, 0.5, 0.72)
    assert policy.false_barge_in(0) is None
    assert policy.false_barge_in(12) is None
    assert policy.false_barge_in(29) == 0.72
    assert policy.false_barge_in(60) is None


def test_offline_queue_is_file_backed_bounded_and_flushes_successes(tmp_path: Path) -> None:
    path = tmp_path / "messages.json"
    queue = OfflineMessageQueue(path, maximum_messages=2)
    queue.enqueue({"call_id": "1", "text": "one"})
    queue.enqueue({"call_id": "2", "text": "two"})
    queue.enqueue({"call_id": "3", "text": "three"})
    assert json.loads(path.read_text(encoding="utf-8")) == [
        {"call_id": "2", "text": "two"},
        {"call_id": "3", "text": "three"},
    ]
    assert path.stat().st_mode & 0o777 == 0o600
    delivered: list[str] = []

    async def sender(message):
        delivered.append(message["call_id"])
        return message["call_id"] == "2"

    remaining = asyncio.run(OfflineMessageQueue(path, 2).flush(sender))
    assert delivered == ["2", "3"]
    assert remaining == 1
    assert json.loads(path.read_text(encoding="utf-8")) == [{"call_id": "3", "text": "three"}]


def test_cached_phrase_config_covers_every_phrase_for_all_launch_languages() -> None:
    providers = yaml.safe_load((Path(__file__).parents[3] / "config" / "providers.yaml").read_text(encoding="utf-8"))
    phrases = providers["resilience"]["cached_phrases"]
    assert set(phrases) == {"apology", "filler", "transfer", "trouble_hearing", "goodbye"}
    assert all(set(translations) == LAUNCH_LANGUAGES for translations in phrases.values())
    assert all(text.strip() for translations in phrases.values() for text in translations.values())


def test_runtime_config_allows_unset_optional_tts_fallback(tmp_path: Path) -> None:
    repository_root = Path(__file__).parents[3]
    providers = yaml.safe_load((repository_root / "config" / "providers.yaml").read_text(encoding="utf-8"))
    providers["tts_fallback"] = None
    providers_path = tmp_path / "providers.yaml"
    providers_path.write_text(yaml.safe_dump(providers), encoding="utf-8")

    config = load_runtime_config(providers_path, repository_root / "config" / "dev-restaurant.yaml")
    assert config.providers["tts_fallback"] is None


def test_failure_actions_never_end_in_silence() -> None:
    policy = FailurePolicy(None, "fallback")
    sequences = [
        policy.stt_failed(b"a"),
        policy.tool_timed_out(),
        policy.supabase_unreachable(),
        policy.spend_cap_or_unpaid(),
    ]
    audible = {ActionKind.PLAY_CACHED, ActionKind.SAY_TOOL_FAILED, ActionKind.TRANSFER, ActionKind.FAQ_ONLY, ActionKind.RECONNECT_STT}
    assert all(any(action.kind in audible for action in sequence) for sequence in sequences)


def test_dtmf_processor_transfers_zero_and_drops_other_keys() -> None:
    emitted = []
    forwarded = []

    async def emit(actions):
        emitted.extend(actions)

    processor = DTMFTransferProcessor(CallBehaviour(), emit)

    async def capture(frame, direction=FrameDirection.DOWNSTREAM):
        forwarded.append((frame, direction))

    processor.push_frame = capture
    asyncio.run(processor.process_frame(InputDTMFFrame(KeypadEntry.ZERO), FrameDirection.DOWNSTREAM))
    asyncio.run(processor.process_frame(InputDTMFFrame(KeypadEntry.SEVEN), FrameDirection.DOWNSTREAM))

    assert kinds(emitted) == [ActionKind.PLAY_CACHED, ActionKind.TRANSFER]
    assert forwarded == []


def test_runtime_wiring_registers_real_pipecat_error_and_idle_hooks() -> None:
    class FakeEmitter:
        def __init__(self):
            self.handlers = {}

        def event_handler(self, event):
            def register(handler):
                self.handlers[event] = handler
                return handler

            return register

    worker, stt, tts, llm = FakeEmitter(), FakeEmitter(), FakeEmitter(), FakeEmitter()

    wire_resilience(
        worker=worker,
        stt=stt,
        tts=tts,
        llm=llm,
        policy=FailurePolicy(None, "fallback"),
        behaviour=CallBehaviour(),
        emit=lambda actions: None,
    )

    assert set(worker.handlers) >= {"on_idle_timeout", "on_pipeline_started", "on_pipeline_finished"}
    assert "on_connection_error" in stt.handlers
    assert "on_error" in tts.handlers
    assert "on_error" in llm.handlers


def test_llm_watchdog_emits_filler_and_fallback_then_cancels_on_first_token() -> None:
    class FakeEmitter:
        def __init__(self):
            self.handlers = {}

        def event_handler(self, event):
            def register(handler):
                self.handlers[event] = handler
                return handler

            return register

    emitted = []

    async def emit(actions):
        emitted.extend(actions)

    worker, stt, tts, llm = FakeEmitter(), FakeEmitter(), FakeEmitter(), FakeEmitter()
    wire_resilience(
        worker=worker,
        stt=stt,
        tts=tts,
        llm=llm,
        policy=FailurePolicy(None, "fallback"),
        behaviour=CallBehaviour(),
        emit=emit,
        first_token_timeout_seconds=0.001,
    )

    async def scenario():
        await llm.handlers["on_before_process_frame"](llm, LLMRunFrame())
        await asyncio.sleep(0.01)
        await llm.handlers["on_before_process_frame"](llm, LLMRunFrame())
        await llm.handlers["on_after_push_frame"](llm, LLMTextFrame("hello"))
        await asyncio.sleep(0.01)

    asyncio.run(scenario())
    assert kinds(emitted) == [ActionKind.PLAY_CACHED, ActionKind.RETRY_LLM]


def test_tts_retry_processor_replays_the_last_speech_frame_once_requested() -> None:
    processor = TTSRetryProcessor()
    forwarded = []

    async def capture(frame, direction=FrameDirection.DOWNSTREAM):
        forwarded.append((frame, direction))

    processor.push_frame = capture

    async def scenario():
        original = TTSSpeakFrame("Please hold.")
        await processor.process_frame(original, FrameDirection.DOWNSTREAM)
        assert await processor.retry() is True

    asyncio.run(scenario())
    assert [frame.text for frame, _ in forwarded] == ["Please hold.", "Please hold."]
    assert all(direction == FrameDirection.DOWNSTREAM for _, direction in forwarded)


def test_false_barge_in_processor_raises_vad_after_three_short_interruptions() -> None:
    moments = iter([0.0, 0.2, 10.0, 10.2, 20.0, 20.2])
    thresholds = []
    policy = NoisePolicy(3, 30, 0.5, 0.72)
    processor = FalseBargeInProcessor(
        policy,
        thresholds.append,
        monotonic=lambda: next(moments),
    )

    async def discard(frame, direction=FrameDirection.DOWNSTREAM):
        return None

    processor.push_frame = discard

    async def scenario():
        await processor.process_frame(BotStartedSpeakingFrame(), FrameDirection.UPSTREAM)
        for _ in range(3):
            await processor.process_frame(UserStartedSpeakingFrame(), FrameDirection.DOWNSTREAM)
            await processor.process_frame(UserStoppedSpeakingFrame(), FrameDirection.DOWNSTREAM)

    asyncio.run(scenario())
    assert thresholds == [0.72]


def test_language_processor_requires_three_dominant_words_before_switching() -> None:
    emitted = []

    async def emit(actions):
        emitted.extend(actions)

    processor = LanguageSwitchProcessor(CallBehaviour(), {"en", "ur"}, emit)

    async def discard(frame, direction=FrameDirection.DOWNSTREAM):
        return None

    processor.push_frame = discard

    async def scenario():
        await processor.process_frame(
            TranscriptionFrame("biryani please", "caller", "now", language="ur"),
            FrameDirection.DOWNSTREAM,
        )
        await processor.process_frame(
            TranscriptionFrame("mujhe biryani chahiye", "caller", "now", language="ur"),
            FrameDirection.DOWNSTREAM,
        )

    asyncio.run(scenario())
    assert kinds(emitted) == [ActionKind.SWITCH_LANGUAGE]


def test_next_tts_language_switches_only_on_a_clear_new_language():
    from voice_receptionist_worker.resilience.runtime import next_tts_language

    supported = {"en", "fr", "ur", "hi", "pa"}
    assert next_tts_language("hi", 5, "en", supported) == "hi"
    assert next_tts_language("hi", 2, "en", supported) is None
    assert next_tts_language("hi", 5, "hi", supported) is None
    assert next_tts_language("fr-CA", 4, "en", supported) == "fr"
    assert next_tts_language("te", 6, "en", supported) is None
