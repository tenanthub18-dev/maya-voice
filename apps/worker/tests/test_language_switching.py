"""Language policy exercised through real queued Pipecat processors, without providers."""
import asyncio
import warnings

import pytest
with warnings.catch_warnings():
    # Pipecat imports Python 3.12 audioop, deprecated upstream for Python 3.13.
    warnings.filterwarnings("ignore", message="'audioop' is deprecated.*", category=DeprecationWarning)
    warnings.filterwarnings("ignore", message="`AudioContextTTSService` is deprecated.*", category=DeprecationWarning)
    from pipecat.frames.frames import (
        EndFrame, InterimTranscriptionFrame, LLMUpdateSettingsFrame,
        TTSUpdateSettingsFrame, TranscriptionFrame,
    )
    from pipecat.pipeline.pipeline import Pipeline
    from pipecat.pipeline.worker import PipelineWorker
    from pipecat.processors.frame_processor import FrameDirection, FrameProcessor
    from pipecat.services.openai.llm import OpenAILLMService
    from pipecat.services.soniox.tts import SonioxTTSService
    from pipecat.workers.runner import WorkerRunner

from voice_receptionist_worker.resilience.runtime import TTSLanguageProcessor


def transcript(text, language="hi", result=None):
    return TranscriptionFrame(text, "caller", "now", language=language, result=result, finalized=True)


def run_frames(frames, supported=None, *, async_callback=True, **kwargs):
    async def scenario():
        seen, changed, before_push = [], [], {}

        async def on_change(language):
            changed.append(language)

        def on_sync_change(language):
            changed.append(language)

        class Sink(FrameProcessor):
            async def process_frame(self, frame, direction):
                await super().process_frame(frame, direction)
                if isinstance(frame, (TranscriptionFrame, InterimTranscriptionFrame,
                                      LLMUpdateSettingsFrame, TTSUpdateSettingsFrame)):
                    seen.append((frame, before_push[frame.id]))
                await self.push_frame(frame, direction)

        processor = TTSLanguageProcessor(
            supported if supported is not None else {"en", "hi", "ur", "fr-CA", "pa", "te", "ar"},
            on_change=on_change if async_callback else on_sync_change, **kwargs,
        )

        @processor.event_handler("on_before_push_frame")
        async def capture_state(current, frame):
            before_push[frame.id] = tuple(changed)

        worker = PipelineWorker(Pipeline([processor, Sink()]), enable_rtvi=False)
        await worker.queue_frames([*frames, EndFrame()])
        runner = WorkerRunner(handle_sigint=False)
        await runner.add_workers(worker)
        await asyncio.wait_for(runner.run(), 5)
        return seen, changed

    return asyncio.run(scenario())


def test_switch_settings_precede_original_transcript_and_do_not_accumulate_instructions():
    frames = [transcript("मुझे एक मेज चाहिए"), transcript("Urdu please"),
              transcript("اردو میں بات کریں"), transcript("English please", "ur")]
    base = "Immutable restaurant rules."
    seen, changed = run_frames(frames, llm_settings_factory=lambda language:
        OpenAILLMService.Settings(system_instruction=f"{base}\ncaller_language={language}"))
    assert changed == ["en", "hi", "ur", "en"]
    assert [type(frame) for frame, _ in seen] == [
        LLMUpdateSettingsFrame, TTSUpdateSettingsFrame,  # Initial language, once.
        LLMUpdateSettingsFrame, TTSUpdateSettingsFrame, TranscriptionFrame,
        LLMUpdateSettingsFrame, TTSUpdateSettingsFrame, TranscriptionFrame,
        TranscriptionFrame,
        LLMUpdateSettingsFrame, TTSUpdateSettingsFrame, TranscriptionFrame,
    ]
    assert [frame for frame, _ in seen if isinstance(frame, TranscriptionFrame)] == frames
    assert all(frame is original for frame, original in zip(
        [frame for frame, _ in seen if isinstance(frame, TranscriptionFrame)], frames))
    updates = [frame.delta.system_instruction for frame, _ in seen
               if isinstance(frame, LLMUpdateSettingsFrame)]
    assert updates == [f"{base}\ncaller_language={code}" for code in changed]
    assert [state[-1] for frame, state in seen if isinstance(frame, TranscriptionFrame)] == [
        "hi", "ur", "ur", "en"]


@pytest.mark.parametrize("text, expected", [
    ("speak Urdu", "ur"), ("Urdu", "ur"), ("اردو میں بات کریں", "ur"),
    ("not Hindi, Urdu please", "ur"), ("don't speak Hindi", None),
    ("I don't want to speak Hindi", None),
    ("Hindi please", "hi"), ("हिंदी में बोलिए", "hi"),
    ("Telugu please", "te"), ("తెలుగులో మాట్లాడండి", "te"),
    ("ਪੰਜਾਬੀ ਵਿੱਚ ਗੱਲ ਕਰੋ", "pa"), ("English please", "en"),
    ("انگریزی میں بات کریں", "en"), ("باللغة العربية من فضلك", "ar"),
    ("Can I order the Hindi special please?", None),
    ("The Urdu menu has great biryani", None),
    ("I speak Urdu at home", None),
    ("Can you speak in Urdu please", "ur"),
    ("Urdu please, not Hindi", "ur"),
    ("हिंदी में बात मत करें", None),
    ("اردو میں بات نہیں کریں", None),
    ("తెలుగులో మాట్లాడవద్దు", None),
])
def test_explicit_requests_override_conflicting_asr_without_food_false_positives(text, expected):
    _, changed = run_frames([transcript(text)], initial_language="fr-CA")
    assert changed == (["fr-CA", expected] if expected else ["fr-CA"])


def test_auto_urdu_after_hindi_and_numbers_or_backchannels_do_not_reset():
    _, changed = run_frames([
        transcript("मुझे एक मेज चाहिए"), transcript("مجھے ایک میز چاہیے", "ur"),
        transcript("آج رات آپ کتنے بجے بند ہوتے ہیں؟", "ur"),
        transcript("416 555 0199", "en"), transcript("$17.99 at 19:30", "en"),
        transcript("okay yes sure", "en"), transcript("جی ہاں", "hi"),
        transcript("seventeen dollars and ninety nine cents", "en"),
    ])
    assert changed == ["en", "hi", "ur"]


def test_token_word_majority_handles_subwords_numbers_and_english_dishes():
    tokens = [
        {"text": "مجھے ", "language": "ur"}, {"text": "ایک ", "language": "ur"},
        {"text": "میز ", "language": "ur"}, {"text": "چاہیے ", "language": "ur"},
        {"text": "butter ", "language": "en"}, {"text": "chicken ", "language": "en"},
        {"text": "17.99 416 555 0199", "language": "en"},
    ]
    english_tokens = [{"text": part, "language": "en"} for part in ["ch", "ick", "en "]]
    seen, changed = run_frames([
        transcript("".join(t["text"] for t in tokens), "en", tokens),
        transcript("chicken", "en", english_tokens),
        transcript("table booking please میز چاہیے", "en", [
            {"text": "table booking please ", "language": "en"},
            {"text": "میز چاہیے", "language": "ur"}]),
    ], initial_language="en")
    assert changed == ["en", "ur", "en"]
    assert len([frame for frame, _ in seen if isinstance(frame, TranscriptionFrame)]) == 3


def test_no_switch_without_strict_majority_or_with_incomplete_metadata():
    _, changed = run_frames([
        transcript("one two three ایک دو تین", "en", [
            {"text": "one two three ", "language": "en"},
            {"text": "ایک دو تین", "language": "ur"}]),
        transcript("one two three ایک دو تین چار", "en", [
            {"text": "one two three ", "language": "en"}, {"text": "ایک دو تین چار"}]),
    ], initial_language="hi")
    assert changed == ["hi"]


def test_regional_initial_language_and_disabled_explicit_target_keep_language():
    seen, changed = run_frames([
        transcript("Urdu please"), transcript("bonjour une table merci", "fr"),
    ], supported={"fr-CA", "en-IN"}, initial_language="fr-CA")
    assert changed == ["fr-CA"]
    assert [frame.delta.language.value for frame, _ in seen
            if isinstance(frame, TTSUpdateSettingsFrame)] == ["fr"]
    _, changed = run_frames([transcript("English please")],
                           supported={"fr-CA", "en-IN"}, initial_language="fr-CA")
    assert changed == ["fr-CA", "en-IN"]


def test_interim_is_ignored_and_numbers_do_not_change_language():
    seen, changed = run_frames([
        InterimTranscriptionFrame("Urdu please", "caller", "now", language="ur"),
        transcript("۱۲ ۳۴ ۵۶", "ur"),
    ])
    assert changed == ["en"]
    assert len([frame for frame, _ in seen if isinstance(frame, InterimTranscriptionFrame)]) == 1


def test_legacy_constructor_without_enabled_english_and_sync_callback():
    seen, changed = run_frames([transcript("اردو میں بات کریں")],
                               supported={"hi", "ur"}, async_callback=False)
    assert changed == ["hi", "ur"]
    assert [frame.delta.language.value for frame, _ in seen
            if isinstance(frame, TTSUpdateSettingsFrame)] == ["hi", "ur"]


def test_empty_supported_languages_does_not_fabricate_support():
    seen, changed = run_frames([transcript("Urdu please")], supported=set())
    assert changed == []
    assert all(isinstance(frame, TranscriptionFrame) for frame, _ in seen)


def test_explicit_request_without_asr_language_and_disabled_auto_language():
    _, changed = run_frames([transcript("Urdu please", None),
                           transcript("मुझे एक मेज चाहिए", "hi")], supported={"en", "ur"})
    assert changed == ["en", "ur"]


def test_upstream_final_transcripts_do_not_change_language():
    async def scenario():
        processor = TTSLanguageProcessor({"en", "ur"}, on_change=lambda code: pytest.fail(code))
        received = []
        class Sink(FrameProcessor):
            def __init__(self):
                super().__init__(enable_direct_mode=True)

            async def process_frame(self, frame, direction):
                received.append((frame, direction))

        sink = Sink()
        sink.link(processor)
        frame = transcript("Urdu please")
        await processor.process_frame(frame, FrameDirection.UPSTREAM)
        assert received == [(frame, FrameDirection.UPSTREAM)]
    asyncio.run(scenario())


@pytest.mark.parametrize("initial,language_request,other,first,second", [
    ("hi", "Urdu please", "hi", "और बटर चिकन कितने का है?", "मुझे एक मेज चाहिए"),
    ("ur", "speak Hindi", "ur", "اور بٹر چکن کتنے کا ہے؟", "مجھے ایک میز چاہیے"),
])
def test_hindi_urdu_preference_needs_two_independent_clear_utterances(
    initial, language_request, other, first, second,
):
    preferred = "ur" if other == "hi" else "hi"
    _, changed = run_frames([
        transcript(language_request, other), transcript(first, other),
        transcript(first, other),  # Duplicate endpoint is not another utterance.
    ], initial_language=initial)
    assert changed == [initial, preferred]
    _, changed = run_frames([
        transcript(language_request, other), transcript(first, other), transcript(second, other),
    ], initial_language=initial)
    assert changed == [initial, preferred, other]


def test_automatic_urdu_is_not_overridden_by_one_hindi_cognate_and_telugu_is_immediate():
    _, changed = run_frames([
        transcript("آج رات آپ کتنے بجے بند ہوتے ہیں؟", "ur"),
        transcript("और बटर चिकन कितने का है?", "hi"),
        transcript("ఈరోజు మీరు ఎన్ని గంటలకు మూసేస్తారు?", "te"),
    ])
    assert changed == ["en", "ur", "te"]


@pytest.mark.parametrize("noise", [
    transcript("416 555 0199", "hi"), transcript("जी हाँ", "hi"),
    transcript("butter chicken please", "hi"),
    transcript("butter chicken please", "hi", [{"text": "butter chicken please", "language": "hi"}]),
    transcript("seventeen dollars and ninety nine cents", "en"),
])
def test_short_or_numeric_or_dish_text_cannot_accumulate_hindi_urdu_evidence(noise):
    _, changed = run_frames([
        transcript("Urdu please"), transcript("और बटर चिकन कितने का है?", "hi"),
        noise, transcript("मुझे एक मेज चाहिए", "hi"),
    ])
    assert changed == ["en", "ur"]


def test_explicit_hindi_and_urdu_override_hysteresis_in_both_directions():
    _, changed = run_frames([
        transcript("Urdu please", "hi"), transcript("speak Hindi", "ur"),
        transcript("don't speak Urdu", "ur"), transcript("Urdu please", "hi"),
    ])
    assert changed == ["en", "ur", "hi", "ur"]
