"""Browser-only, non-billing call snapshots. No audio, prompts or tool payloads.

Pipecat 1.14 source was inspected for all observer/frame contracts below:
https://github.com/pipecat-ai/pipecat/blob/v1.14.0/src/pipecat/observers/service_metrics_observer.py
https://github.com/pipecat-ai/pipecat/blob/v1.14.0/src/pipecat/observers/loggers/transcription_log_observer.py
https://github.com/pipecat-ai/pipecat/blob/v1.14.0/src/pipecat/transports/base_output.py
"""
from __future__ import annotations

import asyncio
import copy
import logging
import math
from collections import OrderedDict
from datetime import datetime, timezone
from decimal import Decimal, ROUND_HALF_UP
from typing import Any
from uuid import UUID, uuid4

from pipecat.frames.frames import (
    BotStoppedSpeakingFrame, CancelFrame, ErrorFrame, InterruptionFrame, SpeechOutputAudioRawFrame,
    TTSAudioRawFrame, TTSTextFrame, TranscriptionFrame,
)
from pipecat.observers.base_observer import BaseObserver
from pipecat.observers.service_metrics_observer import ServiceMetricsObserver

logger = logging.getLogger(__name__)
_FIELDS = (
    "prompt_tokens", "completion_tokens", "total_tokens", "cache_read_input_tokens",
    "cache_creation_input_tokens", "reasoning_tokens", "input_audio_tokens",
    "output_audio_tokens", "cache_read_input_audio_tokens", "audio_seconds",
    "characters", "generated_audio_seconds",
)
_LANGUAGES = {"en", "fr-CA", "ur", "hi", "pa", "te", "ar", "en-IN"}
_OBSERVER_DRAIN_TIMEOUT = 1.0


class CallLoggingError(RuntimeError):
    """Safe public error: never includes database/provider exception contents."""


def _micros(value: Decimal) -> int:
    return int(value.quantize(Decimal("1"), rounding=ROUND_HALF_UP))


def _rate(service: dict, pricing: dict) -> dict | None:
    model = service["model"]
    return next((r for name, r in pricing.get(service["kind"], {}).items()
                 if model == name or model in r.get("aliases", [])), None)


def _cost(service: dict, pricing: dict) -> tuple[int | None, str, bool]:
    """USD per million units equals micro-USD per unit; no invented billed tokens."""
    kind, model, units = service["kind"], service["model"], service["units"]
    rate = _rate(service, pricing)
    if not rate:
        return None, "unpriced_model", False
    d = lambda key: Decimal(str(rate[key]))
    if kind == "llm":
        prompt, completion, cache = (units.get(k) for k in (
            "prompt_tokens", "completion_tokens", "cache_read_input_tokens"))
        # OpenAI prompt_tokens is gross of cache; audio/reasoning providers require
        # separate rate schedules. https://developers.openai.com/api/docs/models/gpt-4.1
        if (prompt is None or completion is None or cache is None or not 0 <= cache <= prompt
                or "cache_read_input_tokens" in service.get("unreported_fields", [])):
            return None, "missing_token_counts", False
        if any(units.get(k) for k in ("input_audio_tokens", "output_audio_tokens", "cache_creation_input_tokens")):
            return None, "unsupported_token_units", False
        cost = (Decimal(prompt - cache) * d("input_per_million")
                + Decimal(cache) * d("cached_input_per_million")
                + Decimal(completion) * d("output_per_million"))
        return _micros(cost), "reported_text_tokens", True
    # https://soniox.com/pricing: seconds and characters are approximate token
    # equivalents ONLY. STT context and output text usage is not reported by Pipecat.
    if kind == "stt" and units.get("audio_seconds") is not None:
        cost = Decimal(str(units["audio_seconds"])) / 3600 * d("audio_tokens_per_hour_estimate") * d("audio_input_per_million")
        return _micros(cost), "estimated_audio_only_excludes_stt_text", False
    if kind == "tts":
        chars, audio = units.get("characters"), units.get("generated_audio_seconds")
        if chars is None:
            return None, "missing_character_usage", False
        cost = Decimal(chars) * d("text_tokens_per_character_estimate") * d("text_input_per_million")
        if audio is not None:
            cost += Decimal(str(audio)) / 3600 * d("audio_tokens_per_hour_estimate") * d("audio_output_per_million")
        return _micros(cost), "estimated_text_and_audio" if audio is not None else "estimated_text_only", audio is not None
    return None, "missing_usage", False


class _MetricsObserver(ServiceMetricsObserver):
    async def on_push_frame(self, data):
        if data.first_push:
            await super().on_push_frame(data)
            # BaseObject handlers are tasks by default in 1.14. Drain each frame's
            # in-memory handlers before the next; never accumulate event tasks.
            # https://github.com/pipecat-ai/pipecat/blob/v1.14.0/src/pipecat/utils/base_object.py
            await self.cleanup()


class _SpeechObserver(BaseObserver):
    def __init__(self, log, output, speech, speech_kind):
        # TTSTextFrame is first pushed by TTS, then released at playback by the
        # output transport. Observe all hops but retain only that output edge.
        super().__init__()
        self.log, self.output, self.speech = log, output, speech
        self.speech_kind = speech_kind
        self.played_ids: OrderedDict[int, None] = OrderedDict()

    async def on_push_frame(self, data):
        log, frame = self.log, data.frame
        if data.first_push and isinstance(frame, ErrorFrame):
            log.flags.add("pipeline_error")  # Never store frame.error or exception.
            log.changed.set()
        elif data.first_push and isinstance(frame, CancelFrame):
            log.flags.add("cancelled")
            log.end_agent(interrupted=True)
            log.changed.set()
        elif data.first_push and isinstance(frame, TranscriptionFrame):
            language = getattr(frame.language, "value", frame.language)
            language = "fr-CA" if language == "fr" else language
            caller_language = language if language in _LANGUAGES else log.language
            if log.assistant_language is None:
                log.language = caller_language
            log.languages.add(caller_language)
            log.add_text("caller", frame.text, data.timestamp, language=caller_language)
        elif isinstance(frame, TTSTextFrame) and self.output is not None and data.source is self.output:
            if frame.id in self.played_ids:
                return
            self.played_ids[frame.id] = None
            if len(self.played_ids) > 8192:
                self.played_ids.popitem(last=False)
            log.add_text("agent", frame.text, data.timestamp, spaces=frame.includes_inter_frame_spaces,
                         language=frame.metadata.get("response_language") or log.assistant_language or log.language)
        elif data.first_push and isinstance(frame, InterruptionFrame):
            log.end_agent(interrupted=True)
        elif data.first_push and isinstance(frame, BotStoppedSpeakingFrame):
            log.end_agent()
        elif (data.first_push and self.speech is not None and data.source is self.speech
              and isinstance(frame, (TTSAudioRawFrame, SpeechOutputAudioRawFrame))):
            # PCM16 from installed TTS/realtime services, measured before transport
            # rechunking/resampling, including audio generated ahead of interruption.
            if frame.sample_rate > 0 and frame.num_channels > 0:
                model = self.speech.settings.model
                log.add_units(self.speech_kind, self.speech.name, model, {"generated_audio_seconds": len(frame.audio) / (2 * frame.sample_rate * frame.num_channels)})


class BrowserCallLog:
    """One bounded writer and coalesced state, independent of the audio path.

    A failed snapshot is sticky even if final persistence recovers. Exiting
    successfully always means the final write completed without any lost writes.
    """
    def __init__(self, repository, *, restaurant_id: str, agent_version_id: str,
                 pricing: dict, transcript_enabled: bool = True, write_timeout: float = 2,
                 flush_timeout: float = 6, snapshot_interval: float = 1):
        self.repository = repository
        self.restaurant_id, self.agent_version_id = restaurant_id, agent_version_id
        self.pricing, self.transcript_enabled = pricing, transcript_enabled
        self.write_timeout, self.flush_timeout, self.snapshot_interval = write_timeout, flush_timeout, snapshot_interval
        self.call_id = ""
        self.started_at = datetime.now(timezone.utc).isoformat()
        self.ended_at: str | None = None
        self.flags: set[str] = set()
        self.language = "en"
        self.assistant_language: str | None = None
        self.languages: set[str] = set()
        self.services: dict[tuple, dict] = {}
        self.turns: list[dict] = []
        self.metrics: list[dict] = []
        self._dirty_turns: set[int] = set()
        self._saved_turns: set[int] = set()
        self._saved_metrics = 0
        self._agent_idx: int | None = None
        self._text_size = 0
        self._failed = False
        self._complete = False
        self.changed = asyncio.Event()
        self._writer: asyncio.Task | None = None
        self._accounting_observers: list[BaseObserver] = []

    async def __aenter__(self):
        creation = asyncio.create_task(self._create(), name="browser-call-create")
        cancelled = False
        # An insert can commit just before cancellation. Settle its bounded
        # request so an existing row can be finalized without opening providers.
        while not creation.done():
            try:
                await asyncio.shield(creation)
            except asyncio.CancelledError:
                cancelled = True
        creation.result()
        if cancelled:
            await self.__aexit__(asyncio.CancelledError, None, None)
            raise asyncio.CancelledError()
        self._writer = asyncio.create_task(self._snapshots(), name="browser-call-snapshots")
        return self

    async def _create(self):
        # Keep the identity even if the insert commits but its response is lost.
        self.call_id = str(uuid4())
        try:
            row = await asyncio.wait_for(self.repository.insert("calls", {
                "id": self.call_id, "restaurant_id": self.restaurant_id, "agent_version_id": self.agent_version_id,
                "source": "browser", "started_at": self.started_at, "ended_at": None,
                "telnyx_call_id": None, "from_e164_hash": None, "from_last4": None,
                "outcome": "answered", "billable_seconds": 0, "recording_path": None,
                "usage": self.usage(),
            }), self.write_timeout)
            if str(UUID(str(row["id"]))) != self.call_id:
                raise ValueError("Unexpected call identity")
        except Exception:
            self._persistence_error()
            self.ended_at = datetime.now(timezone.utc).isoformat()
            try:
                await self._persist_call()
            except Exception:
                # One bounded attempt: a database outage still fails creation,
                # never authorizes providers or claims the row was finalized.
                self._persistence_error()
            raise CallLoggingError("Browser call creation failed") from None

    async def __aexit__(self, exc_type, exc, tb):
        if exc_type is not None:
            self.flags.add("cancelled" if issubclass(exc_type, asyncio.CancelledError) else "pipeline_error")
        self.end_agent(interrupted=bool(self.flags))
        self.ended_at = datetime.now(timezone.utc).isoformat()
        self._complete = not self.flags
        finalizer = asyncio.create_task(self._finish(), name="browser-call-final-flush")
        cancelled = False
        # Shield the bounded flush even when the pipeline/route is cancelled.
        # https://docs.python.org/3/library/asyncio-task.html#shielding-from-cancellation
        while not finalizer.done():
            try:
                await asyncio.shield(finalizer)
            except asyncio.CancelledError:
                cancelled = True
                self.flags.add("cancelled")
                self._complete = False
        finalizer.result()
        if cancelled:
            raise asyncio.CancelledError()
        return False

    def observers(self, *, output, speech, speech_kind="tts"):
        metrics = _MetricsObserver()
        metrics.add_event_handler("on_service_usage", lambda observer, record: self.add_usage(record))
        observers = [metrics, _SpeechObserver(self, output, speech, speech_kind)]
        self._accounting_observers.extend(observers)
        return observers

    def bind_worker(self, worker):
        worker.add_event_handler("on_pipeline_finished", self._drain_observers)

    async def _drain_observers(self, worker, frame):
        # Pipecat is pinned to 1.14.0: the public finished event is awaited by
        # BaseObject.cleanup BEFORE WorkerObserver.cleanup cancels proxy tasks.
        # Its private queues have no public drain API. Join only our accounting
        # observers; leave RTVI/latency observers and the audio path untouched.
        # _MetricsObserver settles usage event tasks before queue.task_done().
        # https://github.com/pipecat-ai/pipecat/blob/v1.14.0/src/pipecat/pipeline/worker.py
        # https://github.com/pipecat-ai/pipecat/blob/v1.14.0/src/pipecat/pipeline/worker_observer.py
        try:
            proxies = getattr(getattr(worker, "_observer", None), "_proxies", None)
            if not isinstance(proxies, dict) or not self._accounting_observers:
                raise ValueError("Unsupported accounting observer proxies")
            queues = [proxies[observer].queue for observer in self._accounting_observers]
            if not all(isinstance(queue, asyncio.Queue) for queue in queues):
                raise ValueError("Unsupported accounting observer queue")
            async with asyncio.timeout(_OBSERVER_DRAIN_TIMEOUT):
                await asyncio.gather(*(queue.join() for queue in queues))
        except Exception:
            self.flags.add("recording_incomplete")
            self._complete = False
            self.changed.set()
            logger.error("Browser call accounting observer drain failed")

    def add_units(self, kind, processor, model, units):
        key = (str(kind), processor, model)
        if key not in self.services:
            if len(self.services) >= 32:
                self.flags.add("recording_incomplete")
                return
            self.services[key] = {"kind": str(kind), "processor": processor, "model": model, "units": {}, "reported_events": 0}
        service = self.services[key]
        for field, value in units.items():
            if field in _FIELDS and value is not None and math.isfinite(value) and value >= 0:
                service["units"][field] = service["units"].get(field, 0) + value
        self.changed.set()
        return service

    def add_usage(self, record):
        service = self.add_units(record.kind, record.processor, record.model, record.model_dump(include=set(_FIELDS), exclude_none=True))
        if service is not None:
            service["reported_events"] += 1
            fields = _FIELDS[:9] if str(record.kind) == "llm" else ("audio_seconds",) if str(record.kind) == "stt" else ("characters",)
            missing = set(service.get("unreported_fields", []))
            missing.update(field for field in fields if getattr(record, field) is None)
            service["unreported_fields"] = sorted(missing)

    def add_text(self, speaker, text, timestamp, *, spaces=False, language=None):
        if not self.transcript_enabled or not text:
            return
        if len(self.turns) >= 1024 or self._text_size + len(text) > 128_000:
            self.flags.add("recording_incomplete")
            return
        ms = max(0, int(timestamp / 1_000_000))
        if (speaker == "agent" and self._agent_idx is not None
                and self.turns[self._agent_idx]["language"] != (language or self.language)):
            self.end_agent()
        if speaker == "agent" and self._agent_idx is not None:
            idx = self._agent_idx
            self.turns[idx]["text"] += ("" if spaces else " ") + text
            self.turns[idx]["ended_ms"] = ms
        else:
            idx = len(self.turns)
            self.turns.append({"idx": idx, "speaker": speaker, "language": language or self.language,
                               "text": text, "started_ms": ms, "ended_ms": ms, "interrupted": False})
            if speaker == "agent":
                self._agent_idx = idx
        self._text_size += len(text) + 1
        self._dirty_turns.add(idx)
        self.changed.set()

    def end_agent(self, *, interrupted=False):
        if self._agent_idx is not None:
            self.turns[self._agent_idx]["interrupted"] = interrupted
            self._dirty_turns.add(self._agent_idx)
            self._agent_idx = None
            self.changed.set()

    def add_latency(self, observer, breakdown):
        from .pipeline.latency import latency_record_from_breakdown
        if len(self.metrics) >= 1024:
            self.flags.add("recording_incomplete")
            return
        record = latency_record_from_breakdown(breakdown, call_id=self.call_id, turn=len(self.metrics))
        self.metrics.append({"turn_idx": record.turn, **{k: round(getattr(record, k)) for k in (
            "eot_ms", "stt_ms", "llm_ttft_ms", "tts_ttfb_ms", "total_ms")}})
        self.changed.set()

    def usage(self):
        services, costs = [], {}
        totals = {key: None for key in _FIELDS}
        fully_priced = True
        for service in self.services.values():
            entry = copy.deepcopy(service)
            entry["rates"] = copy.deepcopy(_rate(entry, self.pricing))
            cost, basis, complete = _cost(entry, self.pricing)
            entry.update(cost_micros=cost, cost_basis=basis, cost_status=("estimated" if complete else "partial") if cost is not None else "unavailable")
            services.append(entry)
            fully_priced &= complete
            if cost is not None:
                costs[entry["kind"]] = costs.get(entry["kind"], 0) + cost
            for field, value in entry["units"].items():
                totals[field] = (totals[field] or 0) + value
        for entry in services:
            for field in entry.get("unreported_fields", []):
                totals[field] = None
        status = "unavailable" if not costs else "estimated" if fully_priced and {s["kind"] for s in services} >= {"stt", "llm", "tts"} and self._complete else "partial"
        return {"schema_version": 1, "currency": self.pricing.get("currency", "USD"),
                "rate_as_of": self.pricing.get("rate_as_of"), "cost_status": status,
                "usage_complete": self._complete and not self._failed, "totals": totals, "services": services}

    def _persistence_error(self):
        self._failed = True
        self.flags.add("recording_incomplete")
        logger.error("Browser call persistence failed")

    async def _persist(self):
        await self._persist_children()
        await self._persist_call()

    async def _persist_children(self):
        # Snapshot only bounded text/metrics; no audio frames or raw provider results.
        try:
            for idx in sorted(self._dirty_turns):
                turn = copy.deepcopy(self.turns[idx])
                filters = {"call_id": self.call_id, "idx": idx}
                if idx in self._saved_turns:
                    await asyncio.wait_for(self.repository.update("call_turns", filters, turn), self.write_timeout)
                else:
                    try:
                        await asyncio.wait_for(self.repository.insert("call_turns", {"call_id": self.call_id, **turn}), self.write_timeout)
                    except Exception as error:
                        # An insert may commit before a response is lost. Retrying
                        # the same unique(call_id,idx) is safe, without duplicate text.
                        if getattr(error, "code", None) != "23505":
                            raise
                        await asyncio.wait_for(self.repository.update("call_turns", filters, turn), self.write_timeout)
                    self._saved_turns.add(idx)
                if self.turns[idx] == turn:
                    self._dirty_turns.discard(idx)
            while self._saved_metrics < len(self.metrics):
                metric = self.metrics[self._saved_metrics]
                try:
                    await asyncio.wait_for(self.repository.insert("call_metrics", {"call_id": self.call_id, **metric}), self.write_timeout)
                except Exception as error:
                    if getattr(error, "code", None) != "23505":
                        raise
                self._saved_metrics += 1
        except Exception:
            self._persistence_error()

    async def _persist_call(self):
        usage = self.usage()
        costs = {}
        for service in usage["services"]:
            if service["cost_micros"] is not None:
                kind = service["kind"]
                costs[kind] = costs.get(kind, 0) + service["cost_micros"]
        await asyncio.wait_for(self.repository.update("calls", {"id": self.call_id, "restaurant_id": self.restaurant_id}, {
            "usage": usage, "cost_micros": costs, "languages": sorted(self.languages),
            "ended_at": self.ended_at, "qa_flags": sorted(self.flags),
            "outcome": "answered", "billable_seconds": 0,
        }), self.write_timeout)

    async def _snapshots(self):
        while True:
            await self.changed.wait()
            self.changed.clear()
            await asyncio.sleep(self.snapshot_interval)
            try:
                await self._persist()
            except Exception:
                self._persistence_error()

    async def _finish(self):
        try:
            async with asyncio.timeout(self.flush_timeout):
                if self._writer:
                    self._writer.cancel()
                    await asyncio.gather(self._writer, return_exceptions=True)
                await self._persist_children()
        except Exception:
            self._persistence_error()
        # Reserve one write_timeout beyond the child flush deadline for terminal
        # metadata. Slow turns must not leave a call active or lose observed usage.
        try:
            await self._persist_call()
        except Exception:
            self._persistence_error()
        if self._failed:
            raise CallLoggingError("Browser call persistence failed") from None
