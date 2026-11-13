from __future__ import annotations

from .policy import Action, ActionKind


class CallBehaviour:
    def __init__(
        self,
        *,
        wrap_up_seconds: float = 540,
        hard_end_seconds: float = 600,
        silence_check_seconds: float = 8,
        silence_end_seconds: float = 16,
    ) -> None:
        self.wrap_up_seconds = wrap_up_seconds
        self.hard_end_seconds = hard_end_seconds
        self.silence_check_seconds = silence_check_seconds
        self.silence_end_seconds = silence_end_seconds
        self._wrapped = False
        self._ended = False
        self._silence_checked = False
        self._unsupported_offered = False
        self._abuse_warned = False

    def elapsed(self, seconds: float) -> list[Action]:
        if seconds >= self.hard_end_seconds and not self._ended:
            self._ended = True
            return [
                Action(ActionKind.PLAY_CACHED, phrase="goodbye"),
                Action(ActionKind.END_CALL),
            ]
        if seconds >= self.wrap_up_seconds and not self._wrapped:
            self._wrapped = True
            return [Action(ActionKind.WRAP_UP)]
        return []

    def silence(self, seconds: float) -> list[Action]:
        if seconds >= self.silence_end_seconds and not self._ended:
            self._ended = True
            return [
                Action(ActionKind.PLAY_CACHED, phrase="goodbye"),
                Action(ActionKind.END_CALL),
            ]
        if seconds >= self.silence_check_seconds and not self._silence_checked:
            self._silence_checked = True
            return [Action(ActionKind.CHECK_SILENCE)]
        return []

    def dtmf(self, key: str) -> list[Action]:
        if key != "0":
            return []
        return [
            Action(ActionKind.PLAY_CACHED, phrase="transfer"),
            Action(ActionKind.TRANSFER),
        ]

    def caller_id(self, value: str | None) -> list[Action]:
        normalized = (value or "").strip().casefold()
        if normalized in {"", "anonymous", "blocked", "private", "restricted", "unknown"}:
            return [Action(ActionKind.ASK_PHONE)]
        return []

    def language(
        self,
        language: str,
        *,
        dominant_word_count: int,
        enabled: set[str],
    ) -> list[Action]:
        if dominant_word_count < 3:
            return []
        if language in enabled:
            return [Action(ActionKind.SWITCH_LANGUAGE, data={"language": language})]
        if self._unsupported_offered:
            return []
        self._unsupported_offered = True
        return [Action(ActionKind.OFFER_SUPPORTED_LANGUAGE, data={"language": "en"})]

    def ai_disclosure_requested(self, requested: bool) -> list[Action]:
        return [Action(ActionKind.DISCLOSE_AI)] if requested else []

    def abuse(self) -> list[Action]:
        if not self._abuse_warned:
            self._abuse_warned = True
            return [Action(ActionKind.WARN_ABUSE)]
        return [
            Action(ActionKind.QA_FLAG),
            Action(ActionKind.PLAY_CACHED, phrase="goodbye"),
            Action(ActionKind.END_CALL),
        ]

    def off_topic(self) -> list[Action]:
        return [Action(ActionKind.REDIRECT_RESTAURANT)]
