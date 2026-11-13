"""Print p50/p95 per latency stage from one or more latency JSONL files.

Usage: uv run python scripts/latency_report.py latency.jsonl [more.jsonl ...]
Rows written before stages_ms existed only contribute the four legacy stages and total.
"""
from __future__ import annotations

import json
import math
import sys
from collections import defaultdict
from pathlib import Path


def percentile(values: list[float], fraction: float) -> float:
    ordered = sorted(values)
    return ordered[max(0, math.ceil(fraction * len(ordered)) - 1)]


def main(paths: list[str]) -> None:
    stages: dict[str, list[float]] = defaultdict(list)
    for path in paths:
        for line in Path(path).read_text(encoding="utf-8").splitlines():
            row = json.loads(line)
            if row.get("eot_ms") == 0.0 and row.get("llm_ttft_ms") == 0.0:
                continue  # greeting turn: nothing was said by the caller
            stages["total"].append(row["total_ms"])
            if row.get("stages_ms"):
                for key, value in row["stages_ms"].items():
                    stages[key].append(value)
            else:
                for key in ("eot_ms", "stt_ms", "llm_ttft_ms", "tts_ttfb_ms"):
                    stages[key].append(row[key])
    if not stages["total"]:
        print("no caller turns found")
        return
    print(f"turns: {len(stages['total'])}")
    print(f"{'stage':24} {'p50 ms':>8} {'p95 ms':>8}")
    for key, values in sorted(stages.items(), key=lambda item: -percentile(item[1], 0.5)):
        print(f"{key:24} {percentile(values, 0.5):8.0f} {percentile(values, 0.95):8.0f}")


if __name__ == "__main__":
    main(sys.argv[1:])
