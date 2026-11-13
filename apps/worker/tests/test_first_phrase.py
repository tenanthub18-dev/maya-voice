import asyncio
import importlib
import importlib.util
import json
import re
import warnings
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

from pipecat.utils.text.base_text_aggregator import TextType
from pipecat.utils.text.simple_text_aggregator import SimpleTextAggregator

from voice_receptionist_worker.pipeline.spoken_numbers import (
    speak_numbers_in_english,
    tts_text_transform,
)


def first_phrase_module():
    name = "voice_receptionist_worker.pipeline.first_phrase"
    assert importlib.util.find_spec(name) is not None, "Phrase streaming aggregation is missing"
    return importlib.import_module(name)


def aggregator(words=6, **kwargs):
    return first_phrase_module().SpokenPhraseTextAggregator(phrase_words=words, **kwargs)


async def feed(subject, text):
    return [part async for part in subject.aggregate(text)]


def chunks(text, size):
    if size == "tokens":
        return re.findall(r"\s+|\w+|[^\w\s]", text)
    return [text[index:index + size] for index in range(0, len(text), size)]


async def collect(subject, text, size):
    parts = []
    for chunk in chunks(text, size):
        parts.extend(await feed(subject, chunk))
    remaining = await subject.flush()
    if remaining:
        parts.append(remaining)
    return parts


def test_emits_six_complete_words_continuously_at_boundaries():
    async def exercise():
        subject = aggregator()
        assert await feed(subject, "We can help with your book") == []
        assert await feed(subject, "ing") == []
        parts = await feed(subject, " ")
        assert [(p.text, p.type) for p in parts] == [
            ("We can help with your booking ", TextType.TOKEN)
        ]
        parts = await feed(subject, "and keep all the remaining details together ")
        assert [(p.text, p.type) for p in parts] == [
            ("and keep all the remaining details ", TextType.TOKEN)
        ]
        assert (await subject.flush()).text == "together "

    asyncio.run(exercise())


@pytest.mark.parametrize("size", [1, 2, "tokens", 1000])
@pytest.mark.parametrize("text", [
    "  Yes.   Next reply.  ",
    "\tWe can help with your booking  and keep all the remaining details\n\n unfinished \t",
    " \t\n\u00a0",
])
def test_native_sentences_and_flush_conserve_exact_whitespace(text, size):
    async def exercise():
        parts = await collect(aggregator(), text, size)
        assert "".join(p.text for p in parts) == text
        assert all(p.type == TextType.TOKEN for p in parts)
    asyncio.run(exercise())


@pytest.mark.parametrize("size", [1, 2, "tokens", 1000])
def test_later_phrases_protect_whole_phone_price_date_time_and_identifiers(size):
    async def exercise():
        text = ("We can help with your booking "
                "Please confirm all these details +1 (416) 555 0199 please "
                "Please confirm all these details １７.９９ € please "
                "Please confirm all these details 2026-11-13 please "
                "Please confirm all these details 12:05 AM "
                "Please confirm all these details AB123 table_12 please ")
        parts = await collect(aggregator(), text, size)
        assert len(parts) == 6
        assert "".join(p.text for p in parts) == text
        for span in ("+1 (416) 555 0199", "１７.９９ €", "2026-11-13", "12:05 AM", "AB123 table_12"):
            assert any(span in p.text for p in parts)
        assert "".join(speak_numbers_in_english(p.text) for p in parts) == speak_numbers_in_english(text)
    asyncio.run(exercise())


@pytest.mark.parametrize("boundary", [" ", "\t", "\n", "\u00a0"])
def test_preserves_any_phrase_boundary_whitespace(boundary):
    async def exercise():
        subject = aggregator()
        parts = await feed(subject, "We can help with your booking" + boundary)
        assert [p.text for p in parts] == ["We can help with your booking" + boundary]
    asyncio.run(exercise())


@pytest.mark.parametrize("ending", [
    "4", "$", "$12", "12.05", "12,05", "１２", "۱۷", "AB123", "table_12",
    "2026-11-13", "10:00", "word$", "word€", "€", "---",
])
def test_waits_past_numeric_identifier_currency_or_nonlexical_endings(ending):
    async def exercise():
        subject = aggregator()
        prefix = f"Please confirm all these details {ending} "
        assert await feed(subject, prefix) == []
        parts = await feed(subject, "please ")
        assert [p.text for p in parts] == [prefix + "please "]
        assert await subject.flush() is None
    asyncio.run(exercise())


@pytest.mark.parametrize("span", [
    "$ 17.99", "17.99 $", "17,99 $", "$ ۱۷.۹۹", "１７.９９ $",
    "£ 17.99", "17.99 ₹", "﷼ ۱۷.۹۹", "₨ １７.９９",
    "+1 (416) 555 0199", "+۱ ۴۱۶ ۵۵۵ ۰۱۹۹", "2026-11-13",
    "10:00 PM", "12:05 AM", "9 a.m.", "AB123", "table_12", "v2.1",
])
@pytest.mark.parametrize("size", [1, 2, 5, 17, "tokens", 1000])
@pytest.mark.parametrize("after_phrase", [False, True])
def test_numeric_groups_stay_whole_at_phrase_boundary(span, size, after_phrase):
    async def exercise():
        prefix = "Please confirm all these details "
        warmup = "We can help with your booking " if after_phrase else ""
        text = warmup + prefix + span + " please and retain the complete corrected readback."
        parts = await collect(aggregator(), text, size)
        # Includes the *whole* numeric span, even if it contains spaces.
        # AM/PM is already a complete lexical word following the numeric clock.
        end = " " if span in {"10:00 PM", "12:05 AM", "9 a.m."} else " please "
        assert parts[int(after_phrase)].text == prefix + span + end
        assert "".join(speak_numbers_in_english(p.text) for p in parts) == (
            speak_numbers_in_english(text)
        )
        assert "".join(p.text for p in parts) == text
    asyncio.run(exercise())


LANGUAGE_CASES = [
    ("en", "Please confirm all these details", "please"),
    ("fr-CA", "Veuillez confirmer tous ces détails", "merci"),
    ("ur", "براہ کرم یہ تمام تفصیلات", "شکریہ"),
    ("hi", "कृपया ये सभी विवरण बताइए", "धन्यवाद"),
    ("pa", "ਕਿਰਪਾ ਕਰਕੇ ਇਹ ਵੇਰਵੇ ਦੱਸੋ", "ਧੰਨਵਾਦ"),
    ("te", "దయచేసి ఈ అన్ని వివరాలు చెప్పండి", "ధన్యవాదాలు"),
    ("ar", "يرجى تأكيد كل هذه التفاصيل", "شكرا"),
]


@pytest.mark.parametrize("language,prefix,following", LANGUAGE_CASES)
@pytest.mark.parametrize("size", [1, 3, 11, "tokens", 1000])
def test_all_seven_languages_conserve_complete_readbacks_and_spoken_numbers(
    language, prefix, following, size,
):
    async def exercise():
        # Numeric group crosses the threshold; no digit, correction or detail may vanish.
        text = (f"{prefix} $17.99 {following} 16,95 $ +1 (416) 555 0199 "
                "2026-11-13 12:05 AM $۱۷.۹۹ $१७.९९ $１７.９９ "
                "AB123 table_12 2026-11-14 corrected complete readback.")
        subject = aggregator(language=language)
        native = SimpleTextAggregator(language=language)
        assert subject.language == native.language
        parts = await collect(subject, text, size)
        assert len(parts) >= 2
        assert all(p.type == TextType.TOKEN for p in parts)
        assert "".join(p.text for p in parts) == text
        spoken = "".join(speak_numbers_in_english(p.text) for p in parts)
        assert spoken == speak_numbers_in_english(text)
        for expected in (
            "seventeen dollars ninety-nine", "sixteen dollars ninety-five",
            "four one six, five five five, zero one nine nine",
            "November thirteen, two thousand twenty-six", "twelve oh five A M",
            "AB123 table_12", "November fourteen, two thousand twenty-six",
        ):
            assert expected in spoken
    asyncio.run(exercise())


def test_native_sentence_can_win_before_six_words_then_phrases_continue():
    async def exercise():
        subject = aggregator()
        text = "Yes, certainly. We can keep every remaining detail together without another prefix. Next sentence."
        parts = await collect(subject, text, 1)
        assert parts[0].text.rstrip() == "Yes, certainly."
        assert parts[1].text.strip() == "We can keep every remaining detail"
        assert len(parts) >= 4
        assert "".join(p.text for p in parts) == text
        assert all(p.type == TextType.TOKEN for p in parts)
    asyncio.run(exercise())


@pytest.mark.parametrize("size", [1, "tokens", 1000])
def test_repeated_phrases_and_native_sentence_boundaries_conserve_text(size):
    async def exercise():
        text = "We can help with your booking and keep all the details. The second sentence remains complete."
        parts = await collect(aggregator(), text, size)
        assert [p.text for p in parts] == [
            "We can help with your booking ",
            "and keep all the details.",
            " The second sentence remains complete.",
        ]
        assert "".join(p.text for p in parts) == text
    asyncio.run(exercise())


@pytest.mark.parametrize("tail", ["", "leftover 416 555 0199", " unfinished"])
def test_every_flush_including_empty_resets_phrase_buffer(tail):
    async def exercise():
        subject = aggregator()
        for _ in range(3):
            parts = await feed(subject, "We can help with your booking " + tail)
            assert [p.text for p in parts] == ["We can help with your booking "]
            remaining = await subject.flush()
            assert (remaining.text if remaining else "") == tail
            assert await subject.flush() is None
    asyncio.run(exercise())


@pytest.mark.parametrize("method", ["handle_interruption", "reset"])
@pytest.mark.parametrize("old", [
    "Please confirm all these details $ 17", "We can help with your booking stale prefix",
])
def test_interruption_and_reset_discard_old_buffer_and_rearm_phrases(method, old):
    async def exercise():
        subject = aggregator()
        await feed(subject, old)
        await getattr(subject, method)()
        assert await subject.flush() is None
        assert [p.text for p in await feed(subject, "We can help with your booking ")] == [
            "We can help with your booking "
        ]
    asyncio.run(exercise())


def test_inherited_language_selection_does_not_discard_pending_prefix():
    async def exercise():
        subject = aggregator(language="fr-CA")
        native = SimpleTextAggregator(language="fr-CA")
        assert await feed(subject, "We can help ") == []
        subject.set_language("hi")
        native.set_language("hi")
        assert subject.language == native.language
        assert [p.text for p in await feed(subject, "with your booking ")] == [
            "We can help with your booking "
        ]
    asyncio.run(exercise())


def real_tts(language="en", mode="token"):
    with warnings.catch_warnings():
        warnings.simplefilter("ignore", DeprecationWarning)
        from pipecat.services.soniox.tts import SonioxTTSService
        from pipecat.services.tts_service import TextAggregationMode
        from pipecat.transcriptions.language import Language
        return SonioxTTSService(
            api_key="test-key", text_aggregation_mode=TextAggregationMode(mode),
            settings=SonioxTTSService.Settings(
                model="test-model", voice="test-voice", language=Language(language.split("-")[0]),
            ),
            text_transforms=[("*", tts_text_transform)],
        )


@pytest.mark.parametrize("value", [None, False, True, -1, 1, 3, 13, 6.0, "6", [], {}])
def test_configuration_rejects_invalid_threshold_without_replacing_aggregator(value, monkeypatch):
    from voice_receptionist_worker.pipeline.config import ProviderConfigError
    monkeypatch.delenv("TTS_AGGREGATION", raising=False)
    subject = real_tts()
    old = subject._text_aggregator
    with pytest.raises(ProviderConfigError, match="phrase_words"):
        first_phrase_module().configure_phrase_streaming(subject, {"tts": {"phrase_words": value}})
    assert subject._text_aggregator is old


@pytest.mark.parametrize("tts_config", [{}, {"phrase_words": 0}])
@pytest.mark.parametrize("mode", ["sentence", "token"])
def test_configuration_is_disabled_by_default_and_zero(tts_config, mode, monkeypatch):
    monkeypatch.delenv("TTS_AGGREGATION", raising=False)
    subject = real_tts(mode=mode)
    old = subject._text_aggregator
    first_phrase_module().configure_phrase_streaming(subject, {"tts": tts_config})
    assert subject._text_aggregator is old


@pytest.mark.parametrize("words", range(4, 13))
def test_configured_threshold_is_used(words, monkeypatch):
    monkeypatch.delenv("TTS_AGGREGATION", raising=False)
    async def exercise():
        subject = real_tts()
        first_phrase_module().configure_phrase_streaming(subject, {"tts": {"phrase_words": words}})
        text = " ".join(["word"] * words)
        assert await feed(subject._text_aggregator, text) == []
        assert [p.text for p in await feed(subject._text_aggregator, " ")] == [text + " "]
    asyncio.run(exercise())


def test_configuration_requires_actual_token_mode_without_mutating_service(monkeypatch):
    from voice_receptionist_worker.pipeline.config import ProviderConfigError
    subject = real_tts(mode="sentence")
    old = subject._text_aggregator
    monkeypatch.setenv("TTS_AGGREGATION", "token")
    with pytest.raises(ProviderConfigError, match="TOKEN"):
        first_phrase_module().configure_phrase_streaming(subject, {"tts": {"phrase_words": 6}})
    assert subject._text_aggregator is old


@pytest.mark.parametrize("mode", [None, "token", "sentence", "invalid"])
def test_aggregation_mode_without_opt_in_preserves_legacy_signature(mode, monkeypatch):
    from voice_receptionist_worker.pipeline.builder import _tts_aggregation_mode
    if mode is None:
        monkeypatch.delenv("TTS_AGGREGATION", raising=False)
    else:
        monkeypatch.setenv("TTS_AGGREGATION", mode)
    if mode == "invalid":
        with pytest.raises(ValueError, match="TTS_AGGREGATION"):
            _tts_aggregation_mode()
    else:
        assert _tts_aggregation_mode() == (mode or "sentence")
        assert _tts_aggregation_mode({"tts": {"phrase_words": 0}}) == (mode or "sentence")


@pytest.mark.parametrize("mode", [None, "token", "sentence"])
@pytest.mark.parametrize("words", range(4, 13))
@pytest.mark.parametrize("model", ["test-model-a", "test-model-b"])
def test_phrase_opt_in_selects_token_for_every_threshold_and_model(mode, words, model, monkeypatch):
    from voice_receptionist_worker.pipeline.builder import _tts_aggregation_mode
    from voice_receptionist_worker.pipeline.config import ProviderConfigError
    if mode is None:
        monkeypatch.delenv("TTS_AGGREGATION", raising=False)
    else:
        monkeypatch.setenv("TTS_AGGREGATION", mode)
    providers = {"tts": {"phrase_words": words}, "voice_llm": {"model": model}}
    if mode == "sentence":
        with pytest.raises(ProviderConfigError, match="phrase_words.*TTS_AGGREGATION"):
            _tts_aggregation_mode(providers)
    else:
        assert _tts_aggregation_mode(providers) == "token"


@pytest.mark.parametrize("value", [None, False, True, -1, 1, 3, 13, 6.0, "6", [], {}])
def test_mode_helper_rejects_invalid_phrase_threshold(value, monkeypatch):
    from voice_receptionist_worker.pipeline.builder import _tts_aggregation_mode
    from voice_receptionist_worker.pipeline.config import ProviderConfigError
    monkeypatch.delenv("TTS_AGGREGATION", raising=False)
    with pytest.raises(ProviderConfigError, match="phrase_words"):
        _tts_aggregation_mode({"tts": {"phrase_words": value}})


@pytest.mark.parametrize("language,prefix,following", LANGUAGE_CASES)
def test_real_soniox_streams_whole_transformed_batches_with_native_token_sequencer(
    language, prefix, following, monkeypatch,
):
    monkeypatch.delenv("TTS_AGGREGATION", raising=False)
    async def exercise():
        subject = real_tts(language)
        from pipecat.frames.frames import TextFrame
        from pipecat.services.tts_service import TextAggregationMode
        from websockets.protocol import State

        settings = subject.settings.copy()
        old_language = subject.text_aggregation_language
        transforms = subject._text_transforms
        sequencer = subject._aggregated_frame_sequencer
        first_phrase_module().configure_phrase_streaming(subject, {"tts": {"phrase_words": 6}})
        assert subject._text_aggregation_mode == TextAggregationMode.TOKEN
        assert subject._is_streaming_tokens
        assert subject.settings == settings
        assert subject.text_aggregation_language == old_language
        assert subject._text_transforms is transforms
        assert subject._aggregated_frame_sequencer is sequencer

        # Only the external socket and audio delivery are replaced; real aggregation,
        # trimming, numeric transforms, context selection and Soniox run_tts all execute.
        sent = []
        async def send(message):
            sent.append(json.loads(message))
        subject._websocket = SimpleNamespace(state=State.OPEN, send=send)
        subject._turn_context_id = "response-stream"
        raw = []
        async def announce(frame, context_id):
            raw.append((frame.text, frame.text_type, context_id))
        monkeypatch.setattr(subject, "_announce_text", announce)
        monkeypatch.setattr(subject, "_start_audio_context", AsyncMock())
        sequenced = []
        async def deliver(frames, context_id):
            sequenced.extend(frames)
        monkeypatch.setattr(subject, "_push_sequencer_frames", deliver)
        # A long, unfinished sentence must keep streaming without creating fake
        # completed sentences in context. Keep registration/sequencing real.
        pending = (f"{prefix} $17.99 {following} "
                   "and keep every single readback complete "
                   "+1 (416) 555 0199 corrected readback please ")
        text = pending + "2026-11-13 12:05 AM AB123 table_12 complete."
        for chunk in chunks(pending, "tokens"):
            await subject._handle_text(TextFrame(chunk))
        assert len([m for m in sent if "text" in m]) >= 3
        assert sequenced == []
        assert subject._aggregated_frame_sequencer._slots == []
        assert list(subject._aggregated_frame_sequencer._streaming_contexts) == ["response-stream"]
        for chunk in chunks(text[len(pending):], "tokens"):
            await subject._handle_text(TextFrame(chunk))
        remaining = await subject._text_aggregator.flush()
        if remaining:
            await subject._handle_aggregated_text(subject._aggregated_text_frame(remaining))
        configs = [message for message in sent if "model" in message]
        messages = [message for message in sent if "text" in message]
        assert len(configs) == 1
        assert configs[0]["voice"] == "test-voice"
        assert configs[0]["language"] == settings.language
        assert len(messages) >= 4
        assert all(m["stream_id"] == "response-stream" and m["text_end"] is False for m in messages)
        assert messages[0]["text"].endswith(f"{following} ")
        assert "".join(m["text"] for m in messages) == await tts_text_transform(text, TextType.TOKEN)
        assert "".join(t for t, _, _ in raw) == text
        assert all(kind == TextType.TOKEN and context == "response-stream" for _, kind, context in raw)
        assert sequenced == []
        anchors = await subject._aggregated_frame_sequencer.finalize("response-stream")
        assert len(anchors) == 1
        assert anchors[0].text == text
        assert anchors[0].context_id == "response-stream"
        assert anchors[0].text_type == TextType.SENTENCE
    asyncio.run(exercise())


@pytest.mark.parametrize("transport", ["phone", "browser"])
def test_cascade_builders_apply_opt_in_phrase_streaming(transport, monkeypatch, tmp_path):
    from voice_receptionist_worker.pipeline import builder
    from voice_receptionist_worker.pipeline.config import load_runtime_config

    first_phrase_module()
    root = Path(__file__).resolve().parents[3]
    config = load_runtime_config(root / "config/providers.yaml", root / "config/dev-restaurant.yaml")
    config.providers["tts"] = {**config.providers["tts"], "phrase_words": 6}
    config.restaurant["id"] = "restaurant-test"
    for name in ("SONIOX_API_KEY", "OPENAI_API_KEY", "TELNYX_API_KEY", "GEMINI_API_KEY"):
        monkeypatch.setenv(name, "test-key")
    monkeypatch.setenv("LATENCY_JSONL_PATH", str(tmp_path / "latency.jsonl"))
    monkeypatch.setenv("ACK_CLIPS", "0")
    monkeypatch.delenv("TTS_AGGREGATION", raising=False)
    monkeypatch.delenv("VOICE_MODE", raising=False)

    def processors(processor):
        for child in processor.processors:
            if child.processors:
                yield from processors(child)
            else:
                yield child

    async def exercise():
        with warnings.catch_warnings():
            warnings.simplefilter("ignore", DeprecationWarning)
            websocket = SimpleNamespace(headers={})
            dispatcher = SimpleNamespace(timeout_seconds=3)
            if transport == "phone":
                worker = builder.build_pipeline(
                    config, websocket,
                    {"call_id": "test-call", "stream_id": "test-stream", "outbound_encoding": "PCMU"},
                    tool_dispatcher=dispatcher, database_call_id="test-call",
                )
            else:
                worker = builder.build_browser_audio_pipeline(
                    config, websocket, tool_dispatcher=dispatcher,
                    database_call_id="test-call", dry_run_tools=True,
                )
        llm = next(p for p in processors(worker.pipeline) if type(p).__name__ == "OpenAILLMService")
        try:
            tts = next(p for p in processors(worker.pipeline)
                       if type(p).__name__ in {"SonioxTTSService", "ResponseLanguageTTS"})
            assert tts._is_streaming_tokens
            parts = await feed(tts._text_aggregator, "We can help with your booking and keep all the remaining details ")
            assert [(p.text, p.type) for p in parts] == [
                ("We can help with your booking ", TextType.TOKEN),
                ("and keep all the remaining details ", TextType.TOKEN),
            ]
        finally:
            await llm._client.close()
    asyncio.run(exercise())
