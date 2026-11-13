"""Opt-in continuous safe phrases within the native TOKEN-mode TTS stream."""

from __future__ import annotations

import re
import unicodedata
from collections.abc import AsyncIterator, Mapping
from typing import Any

from pipecat.utils.text.base_text_aggregator import Aggregation, TextType
from pipecat.utils.text.simple_text_aggregator import SimpleTextAggregator

from .config import ProviderConfigError


_DECIMAL_POINT = re.compile(r"(?<=\d)\.(?=\d)")


class SpokenPhraseTextAggregator(SimpleTextAggregator):
    """Emit complete lexical batches, using native sentence boundaries as an aid.

    Pinned Pipecat 1.14 buffer, sentence lookahead and reset/flush contract:
    https://github.com/pipecat-ai/pipecat/blob/v1.14.0/src/pipecat/utils/text/simple_text_aggregator.py
    """

    def __init__(self, *, phrase_words: int = 6, language: str | None = None):
        super().__init__(language=language)
        self._phrase_words = phrase_words

    async def _check_sentence_with_lookahead(
        self, char: str, *, protected_end: int = 0,
    ) -> Aggregation | None:
        # sentencex recognizes ASCII decimals but can split Unicode Nd prices.
        # Use the inherited protection hook to keep decimal/phone groups intact;
        # offsets and the original text stay unchanged, in every sentence.
        for match in _DECIMAL_POINT.finditer(self._text):
            protected_end = max(protected_end, match.end())
        return await super()._check_sentence_with_lookahead(char, protected_end=protected_end)

    async def aggregate(self, text: str) -> AsyncIterator[Aggregation]:
        for char in text:
            # Native sentence emission takes precedence, including short replies.
            buffered = self._text + char
            async for _ in super().aggregate(char):
                # Native emission strips spaces; recover the exact consumed prefix
                # from its remaining-buffer length, including boundary whitespace.
                consumed = len(buffered) - len(self._text)
                yield Aggregation(text=buffered[:consumed], type=TextType.TOKEN)

            if not char.isspace():
                continue
            words = self._text.split()
            if len(words) < self._phrase_words:
                continue
            ending = words[-1]
            if not any(c.isalpha() for c in ending) or any(
                c.isdecimal() or unicodedata.category(c) == "Sc" for c in ending
            ):
                continue

            # Preserve the boundary whitespace: Soniox concatenates incremental
            # text in the same stream. Never add punctuation or change the words.
            # https://docs.soniox.com/tts/rt/real-time-generation
            prefix = self._text
            await self.reset()
            yield Aggregation(text=prefix, type=TextType.TOKEN)

    async def flush(self) -> Aggregation | None:
        # Native flush strips spaces. Whitespace-only tails are significant too.
        remaining = self._text
        await super().reset()
        return Aggregation(text=remaining, type=TextType.TOKEN) if remaining else None


def _phrase_words(providers: Mapping[str, Any] | None) -> int:
    words = (providers or {}).get("tts", {}).get("phrase_words", 0)
    if type(words) is not int or (words != 0 and not 4 <= words <= 12):
        raise ProviderConfigError("tts.phrase_words must be 0 (disabled) or an integer from 4 to 12")
    return words


def configure_phrase_streaming(tts: Any, providers: Mapping[str, Any]) -> None:
    """Swap only the aggregator; require native TOKEN sequencing and transforms."""
    from pipecat.services.tts_service import TextAggregationMode

    words = _phrase_words(providers)
    if words == 0:
        return
    if tts._text_aggregation_mode != TextAggregationMode.TOKEN:
        raise ProviderConfigError("tts.phrase_words requires TextAggregationMode.TOKEN")

    # The one private TTS integration, pinned to Pipecat 1.14.0. Native TOKEN
    # sequencing regroups batches into real context sentences after transforms.
    # https://github.com/pipecat-ai/pipecat/blob/v1.14.0/src/pipecat/services/tts_service.py
    tts._text_aggregator = SpokenPhraseTextAggregator(
        phrase_words=words, language=tts.text_aggregation_language,
    )
