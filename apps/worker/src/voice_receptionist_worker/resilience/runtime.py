from __future__ import annotations

import asyncio
import dataclasses
import inspect
import re
import time
import unicodedata
from collections import Counter, OrderedDict
from collections.abc import Awaitable, Callable
from functools import cache
from typing import Any

from pipecat.frames.frames import (
    BotStartedSpeakingFrame,
    BotStoppedSpeakingFrame,
    Frame,
    InputDTMFFrame,
    LLMContextFrame,
    LLMFullResponseStartFrame,
    LLMRunFrame,
    LLMTextFrame,
    LLMUpdateSettingsFrame,
    TTSSpeakFrame,
    TTSAudioRawFrame,
    TTSTextFrame,
    TTSUpdateSettingsFrame,
    TranscriptionFrame,
    UserStartedSpeakingFrame,
    UserStoppedSpeakingFrame,
)
from pipecat.processors.frame_processor import FrameDirection, FrameProcessor
from pipecat.services.settings import LLMSettings

from .caller import CallBehaviour
from .policy import Action, FailurePolicy
from .noise import NoisePolicy


ActionEmitter = Callable[[list[Action]], Awaitable[None] | None]


async def _emit(emitter: ActionEmitter, actions: list[Action]) -> None:
    if not actions:
        return
    emitted = emitter(actions)
    if inspect.isawaitable(emitted):
        await emitted


class DTMFTransferProcessor(FrameProcessor):
    """Consume Telnyx DTMF frames and turn only zero into a transfer request.

    Installed Pipecat source contracts used here:
    apps/worker/.venv/lib/python3.12/site-packages/pipecat/serializers/telnyx.py
    apps/worker/.venv/lib/python3.12/site-packages/pipecat/frames/frames.py
    apps/worker/.venv/lib/python3.12/site-packages/pipecat/processors/frame_processor.py
    """

    def __init__(self, behaviour: CallBehaviour, emit: ActionEmitter) -> None:
        super().__init__()
        self._behaviour = behaviour
        self._emit = emit

    async def process_frame(self, frame: Frame, direction: FrameDirection):
        await super().process_frame(frame, direction)
        if isinstance(frame, InputDTMFFrame):
            await _emit(self._emit, self._behaviour.dtmf(frame.button.value))
            return
        await self.push_frame(frame, direction)


class FalseBargeInProcessor(FrameProcessor):
    """Treat sub-600ms interruptions while the bot speaks as false barge-ins."""

    def __init__(
        self,
        policy: NoisePolicy,
        update_threshold: Callable[[float], Any],
        *,
        monotonic: Callable[[], float] = time.monotonic,
    ) -> None:
        super().__init__()
        self._policy = policy
        self._update_threshold = update_threshold
        self._monotonic = monotonic
        self._bot_speaking = False
        self._interruption_started: float | None = None

    async def process_frame(self, frame: Frame, direction: FrameDirection):
        await super().process_frame(frame, direction)
        if isinstance(frame, BotStartedSpeakingFrame):
            self._bot_speaking = True
        elif isinstance(frame, BotStoppedSpeakingFrame):
            self._bot_speaking = False
            self._interruption_started = None
        elif isinstance(frame, UserStartedSpeakingFrame) and self._bot_speaking:
            self._interruption_started = self._monotonic()
        elif isinstance(frame, UserStoppedSpeakingFrame) and self._interruption_started is not None:
            stopped = self._monotonic()
            if stopped - self._interruption_started < 0.6:
                threshold = self._policy.false_barge_in(stopped)
                if threshold is not None:
                    updated = self._update_threshold(threshold)
                    if inspect.isawaitable(updated):
                        await updated
            self._interruption_started = None
        await self.push_frame(frame, direction)


class LanguageSwitchProcessor(FrameProcessor):
    def __init__(
        self,
        behaviour: CallBehaviour,
        enabled_languages: set[str],
        emit: ActionEmitter,
    ) -> None:
        super().__init__()
        self._behaviour = behaviour
        self._enabled_languages = enabled_languages
        self._emit = emit

    async def process_frame(self, frame: Frame, direction: FrameDirection):
        await super().process_frame(frame, direction)
        if isinstance(frame, TranscriptionFrame) and frame.language:
            language = getattr(frame.language, "value", frame.language)
            dominant_words = 0
            if isinstance(frame.result, list):
                dominant_words = sum(
                    len(str(token.get("text", "")).split())
                    for token in frame.result
                    if isinstance(token, dict)
                    and str(token.get("language", token.get("language_code", "")))
                    == str(language)
                )
            if dominant_words == 0:
                dominant_words = len(frame.text.split())
            await _emit(
                self._emit,
                self._behaviour.language(
                    str(language),
                    dominant_word_count=dominant_words,
                    enabled=self._enabled_languages,
                ),
            )
        await self.push_frame(frame, direction)


def next_tts_language(detected: str, word_count: int, current: str, supported: set[str]) -> str | None:
    """Return the TTS language code to switch to, or None to keep the current one."""
    base = detected.split("-")[0]
    if word_count < 3 or base == current or base not in supported:
        return None
    return base


_LANGUAGE_NAMES = {
    "en": ("english", "انگریزی", "अंग्रेज़ी", "अंग्रेजी"),
    "fr": ("french", "français", "francais"),
    "ur": ("urdu", "اردو"),
    "hi": ("hindi", "हिंदी", "हिन्दी"),
    "pa": ("punjabi", "ਪੰਜਾਬੀ"),
    "te": ("telugu", "తెలుగు", "తెలుగులో"),
    "ar": ("arabic", "العربية", "بالعربية"),
}
_LANGUAGE_NAME = re.compile(
    r"(?<!\w)(" + "|".join(re.escape(name) for names in _LANGUAGE_NAMES.values()
                            for name in sorted(names, key=len, reverse=True)) + r")(?!\w)",
    re.IGNORECASE,
)
_NUMBER_ONLY_WORDS = set(
    "zero one two three four five six seven eight nine ten eleven twelve thirteen fourteen "
    "fifteen sixteen seventeen eighteen nineteen twenty thirty forty fifty sixty seventy "
    "eighty ninety hundred thousand million point oh and at am pm a p m dollar dollars cent cents".split()
)
_BACKCHANNEL_WORDS = {"okay", "ok", "yes", "sure", "yeah", "no", "thanks", "oui", "haan", "ji",
                      "جی", "ہاں", "हाँ", "जी", "ਹਾਂ", "ਜੀ", "అవును", "نعم"}


def _explicit_language(text: str) -> tuple[bool, str | None]:
    """A small request grammar, not language-name substring matching or an LLM call."""
    has_request, target = False, None
    for clause in re.split(r"[,;.!?।۔]", text.casefold().replace("’", "'")):
        for match in _LANGUAGE_NAME.finditer(clause):
            before, after = clause[:match.start()].strip(), clause[match.end():].strip()
            request = (
                (before in {"", "please", "not", "no"} and after in {"", "please"})
                or re.fullmatch(
                    r"(?:(?:please|can you|could you|would you|will you|i want to|"
                    r"i would like to|i'd like to|don't|do not|i don't want to)\s+)*"
                    r"(?:speak|talk|reply|respond|continue|switch)"
                    r"(?:\s+(?:to|in|with|me|please))*", before)
                or re.match(r"(?:میں\s+(?:بات|بول|جواب)|में\s+(?:बात|बोल|जवाब)|"
                            r"ਵਿੱਚ\s+ਗੱਲ|మాట్లాడ|من فضلك)", after)
            )
            if not request:
                continue
            has_request = True
            # Scope negation to this clause, so 'not Hindi, Urdu please' selects Urdu.
            if re.search(r"\b(?:not|no|never|don't|dont|do not|stop|avoid)\b|"
                         r"نہیں|نہ|नहीं|मत|ਨਹੀਂ|వద్దు", clause):
                continue
            target = next(code for code, names in _LANGUAGE_NAMES.items()
                          if match.group().casefold() in names)
    return has_request, target


def _word_evidence(parts: list[tuple[str, str]]) -> list[tuple[str, str]]:
    """Join Soniox subword tokens; count alphabetic words, including Indic marks."""
    words: list[tuple[str, str]] = []
    letters: list[str] = []
    votes: Counter[str] = Counter()

    def finish() -> None:
        if letters:
            code, count = votes.most_common(1)[0]
            words.append(("".join(letters), code if count > sum(votes.values()) / 2 else ""))
            letters.clear()
            votes.clear()

    for text, language in parts:
        for char in text:
            if char.isalpha():
                letters.append(char)
                votes[language] += 1
            elif unicodedata.category(char).startswith("M") and letters:
                letters.append(char)
            else:
                finish()
    finish()
    return words


def _dominant_language(frame: TranscriptionFrame) -> str | None:
    # Installed SonioxSTTService.send_endpoint_transcript stores the actual token
    # list in result; tokens may be subwords and include spaces/punctuation.
    # https://github.com/pipecat-ai/pipecat/blob/v1.14.0/src/pipecat/services/soniox/stt.py
    tokens = frame.result if isinstance(frame.result, list) else []
    detected = str(getattr(frame.language, "value", frame.language) or "").split("-")[0]
    tagged = any(isinstance(t, dict) and (t.get("language") or t.get("language_code"))
                 for t in tokens)
    parts = [(str(t.get("text", "")), str(t.get("language") or t.get("language_code") or "")
              .split("-")[0]) for t in tokens if isinstance(t, dict)] if tagged else [(frame.text, detected)]
    words = _word_evidence(parts)
    # Latin dish names cannot establish Hindi/Urdu dominance even when their
    # individual ASR tokens have the wrong label; likewise Indic/Arabic words
    # cannot establish English/French dominance. This only rejects incompatible
    # evidence; languages sharing a script still retain ASR's label.
    words = [(word, code if (any("LATIN" in unicodedata.name(c, "") for c in word)
              == (code in {"en", "fr"})) else "") for word, code in words]
    vocabulary = {word.casefold() for word, _ in words}
    if not words or vocabulary <= _BACKCHANNEL_WORDS or vocabulary <= _NUMBER_ONLY_WORDS:
        return None
    counts = Counter(code for _, code in words if code)
    if not counts:
        return None
    code, count = counts.most_common(1)[0]
    return code if count >= 3 and count > len(words) / 2 else None


class TTSLanguageProcessor(FrameProcessor):
    """Validate caller language before the user aggregator receives final text.

    ``supported`` contains enabled conversation codes, e.g. fr-CA/en-IN; Soniox
    receives only fr/en. ``on_change`` receives the canonical code, initially and
    on changes, and may be sync or async. ``llm_settings_factory(code)`` must
    return the configured LLM's typed delta with a REPLACEMENT system instruction
    built from the immutable base prompt plus validated caller_language. Do not
    append instructions to context or send them as TTSSpeakFrame/LLMTextFrame.

    Installed frame/Settings contract:
    https://github.com/pipecat-ai/pipecat/blob/v1.14.0/src/pipecat/frames/frames.py
    https://github.com/pipecat-ai/pipecat/blob/v1.14.0/src/pipecat/services/settings.py
    https://github.com/pipecat-ai/pipecat/blob/v1.14.0/src/pipecat/services/soniox/tts.py
    Primary-language TTS with embedded English words needs no markup:
    https://docs.soniox.com/tts/concepts/language-mixing
    """

    def __init__(
        self, supported: set[str],
        on_change: Callable[[str], Awaitable[None] | None] | None = None,
        *, initial_language: str | None = None,
        llm_settings_factory: Callable[[str], LLMSettings] | None = None,
    ) -> None:
        super().__init__()
        self._supported = set(supported)
        self._current = self._canonical(initial_language or "en")
        if self._current is None:
            if initial_language is not None:
                raise ValueError("initial_language must be enabled")
            self._current = next(iter(sorted(self._supported)), "en")
        self._on_change = on_change
        self._llm_settings_factory = llm_settings_factory
        self._initialized = not self._supported
        self._pending_language: str | None = None
        self._pending_utterance: tuple[str, str, str] | None = None

    def _canonical(self, code: str) -> str | None:
        if code in self._supported:
            return code
        base = code.split("-")[0]
        if getattr(self, "_current", "").split("-")[0] == base:
            return self._current
        return next((item for item in sorted(self._supported) if item.split("-")[0] == base), None)

    async def _update_language(self, target: str) -> None:
        from pipecat.services.soniox.tts import SonioxTTSService
        from pipecat.transcriptions.language import Language

        if self._on_change:
            result = self._on_change(target)
            if inspect.isawaitable(result):
                await result
        if self._llm_settings_factory:
            update = LLMUpdateSettingsFrame(delta=self._llm_settings_factory(target))
            update.metadata["validated_language"] = target
            await self.push_frame(update)
        update = TTSUpdateSettingsFrame(
            delta=SonioxTTSService.Settings(language=Language(target.split("-")[0])))
        update.metadata["validated_language"] = target
        await self.push_frame(update)
        self._current = target

    async def process_frame(self, frame: Frame, direction: FrameDirection):
        await super().process_frame(frame, direction)
        if direction == FrameDirection.DOWNSTREAM and isinstance(frame, TranscriptionFrame):
            if not self._initialized:
                await self._update_language(self._current)
                self._initialized = True
            explicit, requested = _explicit_language(frame.text)
            detected = requested if explicit else _dominant_language(frame)
            target = self._canonical(detected) if detected else None
            ambiguous_pair = {self._current.split("-")[0], (target or "").split("-")[0]} == {"hi", "ur"}
            if not explicit and ambiguous_pair:
                # Hindi/Urdu cognates routinely receive the other ASR label.
                # Require independent, consecutive dominant utterances, keeping
                # only one candidate. Explicit preferences still apply at once.
                utterance = (frame.user_id, frame.timestamp, frame.text.strip())
                if self._pending_language != target:
                    self._pending_language, self._pending_utterance = target, utterance
                    target = None
                elif self._pending_utterance == utterance:
                    target = None
            else:
                self._pending_language = self._pending_utterance = None
            if target and target != self._current:
                await self._update_language(target)
                self._pending_language = self._pending_utterance = None
        await self.push_frame(frame, direction)


def bind_response_language(llm: FrameProcessor, *, initial_language: str) -> None:
    """Freeze the language actually consumed by the LLM, not caller preference.

    Pipecat's processing/push hooks run inline, unlike WorkerObserver callbacks.
    A pending settings frame cannot relabel an inference already streaming.
    https://github.com/pipecat-ai/pipecat/blob/v1.14.0/src/pipecat/processors/frame_processor.py
    """
    applied_language = initial_language

    @llm.event_handler("on_after_process_frame")
    async def applied(processor, frame):
        nonlocal applied_language
        if isinstance(frame, LLMUpdateSettingsFrame) and (
            frame.service is None or frame.service is processor
        ):
            applied_language = frame.metadata.get("validated_language", applied_language)

    @llm.event_handler("on_before_push_frame")
    async def response_started(processor, frame):
        if isinstance(frame, LLMFullResponseStartFrame):
            frame.metadata["response_language"] = applied_language


class ResponseLanguageTTSMixin:
    """Bind generated audio/words to their Soniox stream before observer queues.

    Compose with the installed SonioxTTSService. create_context_id runs before
    its eager per-stream config; word progress carries that context_id even
    after settings advance. Stamp frames before playback buffers them. Bounded
    state also covers empty/eager contexts which never reach completion hooks.
    https://github.com/pipecat-ai/pipecat/blob/v1.14.0/src/pipecat/services/tts_service.py
    https://github.com/pipecat-ai/pipecat/blob/v1.14.0/src/pipecat/services/soniox/tts.py
    """

    def __init__(self, *args: Any, initial_language: str | None = None, **kwargs: Any) -> None:
        self._response_languages: OrderedDict[str, str] = OrderedDict()
        self._canonical_language = initial_language
        super().__init__(*args, **kwargs)

    async def process_frame(self, frame: Frame, direction: FrameDirection) -> None:
        if direction == FrameDirection.DOWNSTREAM:
            code = frame.metadata.get("response_language") if isinstance(
                frame, LLMFullResponseStartFrame) else None
            if code:
                # Match synthesis to this inference, even if the upstream
                # controller has already validated a subsequent caller turn.
                from pipecat.transcriptions.language import Language

                await super().process_frame(TTSUpdateSettingsFrame(
                    delta=type(self.settings)(language=Language(code.split("-")[0]))), direction)
                self._canonical_language = code
            elif isinstance(frame, TTSUpdateSettingsFrame) and (
                frame.service is None or frame.service is self
            ):
                self._canonical_language = frame.metadata.get("validated_language", self._canonical_language)
        await super().process_frame(frame, direction)

    def create_context_id(self) -> str:
        context_id = super().create_context_id()
        code = getattr(self.settings.language, "value", self.settings.language)
        if code and context_id not in self._response_languages:
            canonical = self._canonical_language
            self._response_languages[context_id] = (
                canonical if canonical and canonical.split("-")[0] == code else str(code))
            if len(self._response_languages) > 256:
                self._response_languages.popitem(last=False)
        return context_id

    async def push_frame(self, frame: Frame, direction: FrameDirection = FrameDirection.DOWNSTREAM) -> None:
        if isinstance(frame, (TTSTextFrame, TTSAudioRawFrame)):
            code = self._response_languages.get(frame.context_id)
            if code:
                frame.metadata["response_language"] = code
        await super().push_frame(frame, direction)

    async def on_audio_context_completed(self, context_id: str) -> None:
        try:
            await super().on_audio_context_completed(context_id)
        finally:
            self._response_languages.pop(context_id, None)

    async def on_audio_context_interrupted(self, context_id: str) -> None:
        try:
            await super().on_audio_context_interrupted(context_id)
        finally:
            self._response_languages.pop(context_id, None)


@cache
def response_language_tts_class():
    # Keep the optional Soniox import lazy, as in the pipeline builder. Reuse
    # one service type across calls and both browser transports.
    from pipecat.services.soniox.tts import SonioxTTSService

    class ResponseLanguageTTS(ResponseLanguageTTSMixin, SonioxTTSService):
        pass

    return ResponseLanguageTTS


class TTSRetryProcessor(FrameProcessor):
    """Keep the most recent speech input so one provider retry can replay it."""

    def __init__(self) -> None:
        super().__init__()
        self._last_speech: LLMTextFrame | TTSSpeakFrame | None = None

    async def process_frame(self, frame: Frame, direction: FrameDirection):
        await super().process_frame(frame, direction)
        if direction == FrameDirection.DOWNSTREAM and isinstance(
            frame, (LLMTextFrame, TTSSpeakFrame)
        ):
            self._last_speech = frame
        await self.push_frame(frame, direction)

    async def retry(self) -> bool:
        if self._last_speech is None:
            return False
        await self.push_frame(dataclasses.replace(self._last_speech), FrameDirection.DOWNSTREAM)
        return True


def wire_resilience(
    *,
    worker: Any,
    stt: Any,
    tts: Any,
    llm: Any,
    policy: FailurePolicy,
    behaviour: CallBehaviour,
    emit: ActionEmitter,
    wrap_up_seconds: float = 540,
    hard_end_seconds: float = 600,
    silence_step_seconds: float = 8,
    first_token_timeout_seconds: float = 2.5,
) -> None:
    """Register Pipecat 1.14.0 service/worker event handlers.

    The event names and callback registration come from the installed sources:
    apps/worker/.venv/lib/python3.12/site-packages/pipecat/processors/frame_processor.py
    apps/worker/.venv/lib/python3.12/site-packages/pipecat/services/stt_service.py
    apps/worker/.venv/lib/python3.12/site-packages/pipecat/pipeline/worker.py
    """
    duration_task: asyncio.Task[None] | None = None
    idle_seconds = 0
    first_token_task: asyncio.Task[None] | None = None

    async def first_token_watchdog() -> None:
        await asyncio.sleep(first_token_timeout_seconds)
        await _emit(
            emit,
            policy.llm_first_token_timed_out(max(2.5, first_token_timeout_seconds) + 0.000001),
        )

    @llm.event_handler("on_before_process_frame")
    async def on_before_llm_frame(processor, frame) -> None:
        nonlocal first_token_task
        if isinstance(frame, (LLMContextFrame, LLMRunFrame)):
            if first_token_task:
                first_token_task.cancel()
            first_token_task = asyncio.create_task(first_token_watchdog())

    @llm.event_handler("on_after_push_frame")
    async def on_after_llm_frame(processor, frame) -> None:
        nonlocal first_token_task
        if isinstance(frame, LLMTextFrame) and first_token_task:
            first_token_task.cancel()
            first_token_task = None

    @stt.event_handler("on_connection_error")
    async def on_stt_connection_error(processor, message) -> None:
        # WebsocketSTTService already reconnects and replays its reconnect audio
        # buffer in stt_service.py; this policy counts exhausted attempts.
        await _emit(emit, policy.stt_failed(b""))

    @tts.event_handler("on_error")
    async def on_tts_error(processor, error) -> None:
        await _emit(emit, policy.tts_failed())

    @llm.event_handler("on_error")
    async def on_llm_error(processor, error) -> None:
        nonlocal first_token_task
        if first_token_task:
            first_token_task.cancel()
            first_token_task = None
        await _emit(
            emit,
            policy.llm_first_token_timed_out(max(2.5, first_token_timeout_seconds) + 0.000001),
        )

    async def duration_limits() -> None:
        await asyncio.sleep(wrap_up_seconds)
        await _emit(emit, behaviour.elapsed(wrap_up_seconds))
        await asyncio.sleep(hard_end_seconds - wrap_up_seconds)
        await _emit(emit, behaviour.elapsed(hard_end_seconds))

    @worker.event_handler("on_pipeline_started")
    async def on_pipeline_started(current_worker, frame) -> None:
        nonlocal duration_task
        duration_task = asyncio.create_task(duration_limits())

    @worker.event_handler("on_idle_timeout")
    async def on_idle_timeout(current_worker) -> None:
        nonlocal idle_seconds
        idle_seconds += silence_step_seconds
        await _emit(emit, behaviour.silence(idle_seconds))

    @worker.event_handler("on_pipeline_finished")
    async def on_pipeline_finished(current_worker, frame) -> None:
        if duration_task:
            duration_task.cancel()
        if first_token_task:
            first_token_task.cancel()
