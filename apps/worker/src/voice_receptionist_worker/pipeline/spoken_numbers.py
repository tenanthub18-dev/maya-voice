"""Rewrite digits as English words just before text-to-speech, whatever language the reply is in.

The LLM writes plain digits ($21.95, 10:00 PM, 4165550199); this supplies English words
("twenty-one dollars ninety-five", "ten P M", digit by digit for phone numbers). The conversation
context keeps the digits. Registered as a Pipecat TTS text transform:
apps/worker/.venv/lib/python3.12/site-packages/pipecat/utils/text/transforms/text_transform.py
Pronunciation within the configured primary language still needs native listening checks:
https://docs.soniox.com/tts/concepts/language-mixing
"""
from __future__ import annotations

import re
import unicodedata
from datetime import date

_ONES = (
    "zero one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen "
    "sixteen seventeen eighteen nineteen"
).split()
_TENS = "_ _ twenty thirty forty fifty sixty seventy eighty ninety".split()


def _words(number: int) -> str:
    if number < 20:
        return _ONES[number]
    if number < 100:
        tens, ones = divmod(number, 10)
        return _TENS[tens] + (f"-{_ONES[ones]}" if ones else "")
    if number < 1000:
        hundreds, rest = divmod(number, 100)
        return f"{_ONES[hundreds]} hundred" + (f" {_words(rest)}" if rest else "")
    if number < 1_000_000:
        thousands, rest = divmod(number, 1000)
        return f"{_words(thousands)} thousand" + (f" {_words(rest)}" if rest else "")
    return _digits(str(number))


def _digits(text: str) -> str:
    return " ".join(_ONES[int(character)] for character in text)


def _two_digits(text: str) -> str:
    """Minutes: 05 -> 'oh five', 30 -> 'thirty'."""
    return f"oh {_ONES[int(text)]}" if text.startswith("0") and text != "00" else _words(int(text))


_INTEGER = r"(?:\d{1,3}(?:,\d{3})+|\d+)"
_PRICE = re.compile(r"\$\s?(" + _INTEGER + r")(?:\.(\d{2}))?")
# French and others put the symbol after the number: 16,95 $ or 16.95$
_PRICE_AFTER = re.compile(r"(\d+(?:,\d{3})*)(?:[.,](\d{2}))?\s?\$")
_TIME_AMPM = re.compile(r"\b(\d{1,2})(?::(\d{2}))?\s?([AaPp])\.?[Mm]\.?(?![A-Za-z])")
_TIME_24H = re.compile(r"\b([01]?\d|2[0-3]):([0-5]\d)\b")
_PHONE = re.compile(r"(?:\+?1[\s.-]?)?\(?(\d{3})\)?[\s.-]?(\d{3})[\s.-]?(\d{4})")
_MONTHS = ("January February March April May June July August September October November December").split()
# One pass prevents later rules from rewriting protected IDs/invalid times or
# already-spoken output. This is a deliberately small ISO-only date grammar.
_SPOKEN = re.compile(
    r"(?P<url>(?:https?://|www\.)[^\s]+)"
    r"|(?P<date>(?<![\w-])\d{4}-\d{2}-\d{2}(?![\w-]))"
    r"|(?P<price>\$\s?\d+(?:[.,٬٫]\d+)*|(?<![\w.,])\d+(?:[.,٬٫]\d+)*\s?\$)"
    r"|(?P<time>(?<![\w:])\d+(?::\d+)*\s?[AaPp]\.?[Mm]\.?(?!\w)"
    r"|(?<![\w:])\d+:\d+(?::\d+)*(?![\w:]))"
    r"|(?P<identifier>\b(?=[\w./-]*\d)(?=[\w./-]*[^\W\d_])[\w]+(?:[./-][\w]+)*\b)"
    # Capture any decimal country digit, then validate +1 after normalization.
    r"|(?P<phone>(?<!\w)" + _PHONE.pattern.replace("1", r"\d", 1) + r"(?!\w))"
    r"|(?P<number>(?<![\w.])(?:\d{1,3}(?:[,٬]\d{3})+|\d+)(?:[.٫]\d+)?(?!\w))"
)


def _price(match: re.Match[str]) -> str:
    dollars, cents = int(match.group(1).replace(",", "")), int(match.group(2) or "0")
    if not cents:
        return f"{_words(dollars)} dollar{'s' if dollars != 1 else ''}"
    if dollars >= 1 and cents >= 10:
        return f"{_words(dollars)} dollar{'s' if dollars != 1 else ''} {_words(cents)}"
    spoken_cents = f"{_words(cents)} cent{'s' if cents != 1 else ''}"
    return (f"{_words(dollars)} dollar{'s' if dollars != 1 else ''} and " if dollars else "") + spoken_cents


def _time_ampm(match: re.Match[str]) -> str:
    hour, minutes, meridiem = int(match.group(1)), match.group(2), match.group(3).upper()
    spoken = _words(hour)
    if minutes and minutes != "00":
        spoken += f" {_two_digits(minutes)}"
    return f"{spoken} {meridiem} M"


def _time_24h(match: re.Match[str]) -> str:
    hour, minutes = int(match.group(1)), match.group(2)
    return _words(hour) + ("" if minutes == "00" else f" {_two_digits(minutes)}")


def _phone(match: re.Match[str]) -> str:
    return ", ".join(_digits(group) for group in match.groups())


def _speak_match(match: re.Match[str]) -> str:
    text = match.group()
    # Python's decimal() accepts all Unicode Nd digits, not numeric symbols
    # such as superscripts. https://docs.python.org/3/library/unicodedata.html
    normalized = "".join(str(unicodedata.decimal(char)) if char.isdecimal() else char
                         for char in text).replace("٬", ",").replace("٫", ".")
    kind = match.lastgroup
    if kind in {"url", "identifier"}:
        return text
    if kind == "date":
        try:
            value = date.fromisoformat(normalized)
        except ValueError:
            return text
        return f"{_MONTHS[value.month - 1]} {_words(value.day)}, {_words(value.year)}"
    if kind == "price":
        price = (_PRICE if normalized.startswith("$") else _PRICE_AFTER).fullmatch(normalized)
        return _price(price) if price else text
    if kind == "time":
        ampm = _TIME_AMPM.fullmatch(normalized)
        if ampm:
            return (_time_ampm(ampm) if 1 <= int(ampm[1]) <= 12
                    and int(ampm[2] or "0") < 60 else text)
        clock = _TIME_24H.fullmatch(normalized)
        return _time_24h(clock) if clock else text
    if kind == "phone":
        phone = _PHONE.fullmatch(normalized)
        return _phone(phone) if phone else text
    whole, dot, fraction = normalized.replace(",", "").partition(".")
    return _words(int(whole)) + (f" point {_digits(fraction)}" if dot else "")


def speak_numbers_in_english(text: str) -> str:
    try:
        # Arabic decimal/group separators are normalized only in numeric spans.
        # Their pattern equivalents also preserve all nonnumeric text verbatim.
        return _SPOKEN.sub(_speak_match, text)
    except (ValueError, IndexError):
        return text  # a failing transform would silence the whole turn


async def tts_text_transform(text: str, text_type: object) -> str:
    return speak_numbers_in_english(text)
