from __future__ import annotations

from dataclasses import dataclass, field
from enum import StrEnum
from typing import Any

from voice_receptionist_worker.security.redaction import redacted_logger


logger = redacted_logger(__name__)


class ActionKind(StrEnum):
    RECONNECT_STT = "reconnect_stt"
    REPLAY_AUDIO = "replay_audio"
    RETRY_TTS = "retry_tts"
    USE_FALLBACK_TTS = "use_fallback_tts"
    RETRY_LLM = "retry_llm"
    PLAY_CACHED = "play_cached"
    TRANSFER = "transfer"
    SAY_TOOL_FAILED = "say_tool_failed"
    FAQ_ONLY = "faq_only"
    QUEUE_MESSAGES = "queue_messages"
    WRAP_UP = "wrap_up"
    END_CALL = "end_call"
    CHECK_SILENCE = "check_silence"
    ASK_PHONE = "ask_phone"
    SWITCH_LANGUAGE = "switch_language"
    OFFER_SUPPORTED_LANGUAGE = "offer_supported_language"
    DISCLOSE_AI = "disclose_ai"
    WARN_ABUSE = "warn_abuse"
    QA_FLAG = "qa_flag"
    REDIRECT_RESTAURANT = "redirect_restaurant"


@dataclass(frozen=True)
class Action:
    kind: ActionKind
    phrase: str | None = None
    data: dict[str, Any] = field(default_factory=dict)


class FailurePolicy:
    """Deterministic, per-call failure decisions with no silent terminal branch."""

    def __init__(
        self,
        tts_fallback: dict[str, Any] | None,
        llm_fallback: str | None,
        *,
        llm_terminal: str = "transfer",
    ) -> None:
        if llm_terminal not in {"transfer", "take_message"}:
            raise ValueError("llm_terminal must be transfer or take_message")
        self.tts_fallback = tts_fallback
        self.llm_fallback = llm_fallback
        self.llm_terminal = llm_terminal
        self.stt_failures = 0
        self.tts_failures = 0
        self.llm_timeouts = 0
        self.using_fallback_tts = False

    def stt_failed(self, buffered_audio: bytes) -> list[Action]:
        self.stt_failures += 1
        if self.stt_failures < 2:
            return [
                Action(ActionKind.RECONNECT_STT, data={"deadline_seconds": 1.0}),
                Action(ActionKind.REPLAY_AUDIO, data={"audio": buffered_audio}),
            ]
        return [
            Action(ActionKind.PLAY_CACHED, phrase="trouble_hearing"),
            Action(ActionKind.TRANSFER),
        ]

    def tts_failed(self) -> list[Action]:
        self.tts_failures += 1
        if self.tts_failures == 1:
            return [Action(ActionKind.RETRY_TTS)]
        if self.tts_fallback:
            self.using_fallback_tts = True
            return [
                Action(
                    ActionKind.USE_FALLBACK_TTS,
                    data={"config": self.tts_fallback, "for_rest_of_call": True},
                )
            ]
        logger.warning("tts_fallback is not configured; using cached apology and transfer")
        return [
            Action(ActionKind.PLAY_CACHED, phrase="apology"),
            Action(ActionKind.TRANSFER),
        ]

    def llm_first_token_timed_out(self, elapsed_seconds: float) -> list[Action]:
        if elapsed_seconds <= 2.5:
            return []
        self.llm_timeouts += 1
        if self.llm_timeouts == 1 and self.llm_fallback:
            return [
                Action(ActionKind.PLAY_CACHED, phrase="filler"),
                Action(
                    ActionKind.RETRY_LLM,
                    data={"model": self.llm_fallback, "timeout_seconds": 2.5},
                ),
            ]
        terminal = ActionKind.TRANSFER if self.llm_terminal == "transfer" else ActionKind.QUEUE_MESSAGES
        return [Action(ActionKind.PLAY_CACHED, phrase="apology"), Action(terminal)]

    def tool_timed_out(self) -> list[Action]:
        return [
            Action(
                ActionKind.SAY_TOOL_FAILED,
                data={"claim_success": False, "timeout_seconds": 3.0},
            )
        ]

    def supabase_unreachable(self) -> list[Action]:
        return [Action(ActionKind.FAQ_ONLY), Action(ActionKind.QUEUE_MESSAGES)]

    def spend_cap_or_unpaid(self) -> list[Action]:
        return [Action(ActionKind.TRANSFER)]
