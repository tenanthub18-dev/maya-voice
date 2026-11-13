import numpy as np
import pytest

from voice_receptionist_worker.pipeline.ack import ACK_PHRASES, resample


def test_every_launch_language_has_listening_phrases():
    assert set(ACK_PHRASES) == {"en", "fr", "hi", "pa", "ur", "te", "ar"}
    assert all(phrases and all(p.startswith("[warm] ") for p in phrases) for phrases in ACK_PHRASES.values())


@pytest.mark.parametrize("rate", [8000, 16000, 24000])
def test_resample_keeps_duration(rate):
    one_second = (np.sin(np.linspace(0, 440 * 2 * np.pi, 24000)) * 8000).astype(np.int16).tobytes()
    out = resample(one_second, rate)
    assert abs(len(out) / 2 - rate) <= 2


def test_probe_builds_without_import_time_pipecat_warnings(tmp_path):
    from voice_receptionist_worker.pipeline.ack import AckPlayer, make_probe

    assert type(make_probe(AckPlayer("k", "m", "v"), tmp_path / "x.jsonl", "c")).__name__ == "ContentLatencyProbe"
