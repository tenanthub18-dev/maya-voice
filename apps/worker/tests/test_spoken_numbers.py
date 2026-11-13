import pytest

from voice_receptionist_worker.pipeline.spoken_numbers import speak_numbers_in_english as speak


@pytest.mark.parametrize(
    ("text", "expected"),
    [
        ("$21.95", "twenty-one dollars and ninety-five cents"),
        ("16.95 $", "sixteen dollars and ninety-five cents"),
        ("16,95$", "sixteen dollars and ninety-five cents"),
        ("12 $", "twelve dollars"),
        ("$16", "sixteen dollars"),
        ("$1", "one dollar"),
        ("$12.05", "twelve dollars and five cents"),
        ("10:00 PM", "ten P M"),
        ("7:30 pm", "seven thirty P M"),
        ("9 a.m.", "nine A M"),
        ("19:30", "nineteen thirty"),
        ("table for 4 people", "table for four people"),
        ("4165550199", "four one six, five five five, zero one nine nine"),
        ("(416) 555-0199", "four one six, five five five, zero one nine nine"),
        ("+1 416 555 0199", "four one six, five five five, zero one nine nine"),
        ("1,250 items", "twelve hundred fifty items".replace("twelve hundred", "one thousand two hundred")),
        ("आज रात 10:00 PM बजे, $21.95 का", "आज रात ten P M बजे, twenty-one dollars and ninety-five cents का"),
        ("no digits here", "no digits here"),
    ],
)
def test_digits_become_english_words(text, expected):
    assert speak(text) == expected


def test_failures_return_the_original_text(monkeypatch):
    import voice_receptionist_worker.pipeline.spoken_numbers as module

    monkeypatch.setattr(module, "_words", lambda number: (_ for _ in ()).throw(ValueError("boom")))
    assert speak("$5") == "$5"


@pytest.mark.parametrize(("text", "expected"), [
    ("$17.99", "seventeen dollars and ninety-nine cents"),
    ("$0.05", "five cents"), ("$0.01", "one cent"),
    ("$1.01", "one dollar and one cent"), ("$0.00", "zero dollars"),
    ("$17.00", "seventeen dollars"),
    ("It's $17.99.", "It's seventeen dollars and ninety-nine cents."),
    ("$17.99, please", "seventeen dollars and ninety-nine cents, please"),
    ("$17.999", "$17.999"),
    ("$1,250.05", "one thousand two hundred fifty dollars and five cents"),
    ("1,250.05 $", "one thousand two hundred fifty dollars and five cents"),
    ("17.99", "seventeen point nine nine"), ("0.05", "zero point zero five"),
    ("1,234.56", "one thousand two hundred thirty-four point five six"),
    ("قیمت $۱۷.۹۹", "قیمت seventeen dollars and ninety-nine cents"),
    ("कीमत $१७.९९", "कीमत seventeen dollars and ninety-nine cents"),
    ("ਮੇਜ਼ ੪", "ਮੇਜ਼ four"), ("మొత్తం ౧౭.౯౯", "మొత్తం seventeen point nine nine"),
    ("السعر $١٧.٩٩", "السعر seventeen dollars and ninety-nine cents"),
    ("$１.０５", "one dollar and five cents"),
    ("١٢٬٣٤٥٫٦٧", "twelve thousand three hundred forty-five point six seven"),
    ("+1 (416) 555-0199", "four one six, five five five, zero one nine nine"),
    ("+۱ ۴۱۶ ۵۵۵ ۰۱۹۹", "four one six, five five five, zero one nine nine"),
    ("+１ ４１６ ５５５ ０１９９", "four one six, five five five, zero one nine nine"),
    ("12:05 AM", "twelve oh five A M"), ("00:05", "zero oh five"),
    ("23:59", "twenty-three fifty-nine"),
    ("25:99 PM", "25:99 PM"), ("13:30 PM", "13:30 PM"),
    ("12:60", "12:60"), ("24:00", "24:00"),
    ("7:300 PM", "7:300 PM"),
    ("300:00", "300:00"), ("19:30:00", "19:30:00"),
    ("9pm", "nine P M"), ("7:30pm", "seven thirty P M"),
    ("2026-11-12", "November twelve, two thousand twenty-six"),
    ("2026-02-30", "2026-02-30"),
    ("https://example.ca/menu/17.99?id=123", "https://example.ca/menu/17.99?id=123"),
    ("gemini-3.5-flash table_12 AB123 123ABC v2.1", "gemini-3.5-flash table_12 AB123 123ABC v2.1"),
    ("order-id 2026-11-12-X", "order-id 2026-11-12-X"),
    ("No digits: اردو हिंदी ਪੰਜਾਬੀ తెలుగు العربية", "No digits: اردو हिंदी ਪੰਜਾਬੀ తెలుగు العربية"),
])
def test_precise_numbers_without_corrupting_identifiers(text, expected):
    assert speak(text) == expected


def test_tts_transform_preserves_the_llm_frame_and_context():
    import asyncio
    from pipecat.frames.frames import LLMTextFrame
    from voice_receptionist_worker.pipeline.spoken_numbers import tts_text_transform

    frame = LLMTextFrame("قیمت $17.99")
    assert asyncio.run(tts_text_transform(frame.text, "sentence")) == (
        "قیمت seventeen dollars and ninety-nine cents")
    assert frame.text == "قیمت $17.99"
