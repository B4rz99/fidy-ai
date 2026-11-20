"""Summarize diagnostic browser phases from a storage-reference run directory."""

import argparse
from collections import Counter
import json
import math
from pathlib import Path
import statistics

JOURNEYS = ("read.browser", "dashboard.fresh.browser")
VARIANTS = ("d1", "do")
BROWSER_PHASES = (
    "windowMs",
    "clickToRequestMs",
    "requestToResponseMs",
    "responseToPaintMs",
    "responseToControlsReadyMs",
    "controlsReadyToPaintMs",
)
RESOURCE_ROLES = ("binding", "categories", "dashboard-catalog", "needs-review", "script-or-style", "user")


def read_rows(path):
    return [json.loads(line) for line in path.read_text().splitlines()]


def stats(values):
    return {
        "count": len(values),
        "median": statistics.median(values),
        "p95": sorted(values)[math.ceil(.95 * len(values)) - 1],
    }


def collect(directory):
    rows = read_rows(directory / "attempts.jsonl")
    for row in rows:
        events = read_rows(directory / f"{row['pair']}-{row['variant']}" / "workspace-events.jsonl")
        row["phases"] = {event["journey"]: event for event in events if event.get("type") == "phases"}
    return rows


def describe_phase_measurements(comparable, journey, variant):
    values = {}
    for row in comparable:
        if row["variant"] != variant:
            continue
        phases = row["phases"][journey]
        reported = row["timings"][journey]
        measurements = {key: phases[key] for key in BROWSER_PHASES if key in phases}
        measurements.update(
            reportedBrowserMs=reported,
            harnessOutsideClickWindowMs=reported - phases["windowMs"],
        )
        for role in RESOURCE_ROLES:
            matching = [entry for entry in phases["resources"] if entry["role"] == role]
            measurements[f"{role}.count"] = len(matching)
            if matching:
                measurements[f"{role}.lastResponseAfterClickMs"] = max(
                    entry["endAfterClickMs"] for entry in matching
                )
        for key, durations in phases["serverTiming"].items():
            for index, duration in enumerate(durations, 1):
                measurements[f"server.{key}[{index}]"] = duration
        for key, elapsed in measurements.items():
            values.setdefault(key, []).append(elapsed)
    return {key: stats(observations) for key, observations in sorted(values.items())}


def summarize(rows, journey):
    status = {
        variant: Counter(
            row["phases"].get(journey, {}).get("status", "unobserved")
            for row in rows
            if row["variant"] == variant
        )
        for variant in VARIANTS
    }
    eligible = [
        row for row in rows
        if row["status"] == "ok" and row["phases"].get(journey, {}).get("status") == "observed"
    ]
    pair_ids = set.intersection(*(
        {row["pair"] for row in eligible if row["variant"] == variant} for variant in VARIANTS
    ))
    comparable = [row for row in eligible if row["pair"] in pair_ids]
    return {
        "observations": status,
        "comparablePairs": len(pair_ids),
        **{variant: describe_phase_measurements(comparable, journey, variant) for variant in VARIANTS},
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("run", type=Path, help="Directory containing attempts.jsonl and per-attempt journals")
    args = parser.parse_args()
    rows = collect(args.run)
    print(json.dumps({journey: summarize(rows, journey) for journey in JOURNEYS}, indent=2))


if __name__ == "__main__":
    main()
