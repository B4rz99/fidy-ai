"""Interleave exact native revisions using the unchanged reference journey."""

import json
import math
import os
from pathlib import Path
import statistics
import subprocess
import sys
import time

import run

BASELINE = "e5ef953abd694481c3eb4a09f2bbf7a6e844b379"
CANDIDATE = "92de8d58905b583f85c8d2323bc1a6824a86f270"
PAIRS = 8


def evidence(destination, observation):
    phases = next(
        item for line in (destination / "workspace-events.jsonl").read_text().splitlines()
        if (item := json.loads(line)).get("type") == "startup-phases"
    )
    binding = phases["binding"]
    assert [request["context"] for request in binding] == ["transactions", None], binding
    context, recheck = binding
    assert 0 < context["start"] < context["end"] <= recheck["end"] <= phases["sampled"], phases
    return {
        "startup": observation["timings"]["startup.browser"],
        "domContentLoaded": phases["dom"],
        "bindingDispatch": context["start"],
        "bindingBodyComplete": context["end"],
        "recheckBodyComplete": recheck["end"],
        "recheckToPostPaintSample": phases["sampled"] - recheck["end"],
    }


def summarize(rows):
    report = {}
    for phase in rows[0]["baseline"]:
        baseline = [row["baseline"][phase] for row in rows]
        candidate = [row["candidate"][phase] for row in rows]
        rank = math.ceil(0.95 * len(rows)) - 1
        report[phase] = {
            "baselineMedian": statistics.median(baseline),
            "candidateMedian": statistics.median(candidate),
            "baselineP95": sorted(baseline)[rank],
            "candidateP95": sorted(candidate)[rank],
            "pairedMedianDelta": statistics.median(b - a for a, b in zip(baseline, candidate)),
            "candidateFaster": sum(b < a for a, b in zip(baseline, candidate)),
        }
    return report


def main():
    paths = {variant: Path(argument).resolve() for variant, argument in zip(("baseline", "candidate"), sys.argv[1:])}
    revisions = {variant: run.revision(path, "do") for variant, path in paths.items()}
    assert revisions == {"baseline": BASELINE, "candidate": CANDIDATE}, revisions
    assert run.output(["bun", "--version"], run.ROOT) == "1.4.4"
    port = run.WEB_PORT["do"]
    destination = run.RESULTS / f"same-native-{time.time_ns()}"
    destination.mkdir(parents=True)
    key = destination / "tls.key"
    cert = destination / "tls.crt"
    env = {
        **os.environ,
        "FIDY_REFERENCE": "1",
        "FIDY_REFERENCE_NATIVE_PAIR": "1",
        "FIDY_REFERENCE_READ_ONLY": "1",
        "FIDY_ASSESSMENT": "production",
        "FIDY_ASSESSMENT_NETWORK": "normal",
        "FIDY_REFERENCE_SETUP_IDLE_MS": "0",
        "CLI_ACCEPTANCE_MODE": "cli",
        "REFERENCE_WEB_PORT": str(port),
        "PLAYWRIGHT_TLS_KEY": str(key),
        "PLAYWRIGHT_TLS_CERT": str(cert),
    }
    (destination / "plan.json").write_text(json.dumps({
        "diagnosticOnly": True,
        "revisions": revisions,
        "pairs": PAIRS,
        "order": "alternating baseline-first and candidate-first",
        "dataset": "production",
        "network": "normal",
        "nativePort": port,
        **run.browser_workload("production", read_only=True),
    }, indent=2) + "\n")
    subprocess.run([
        "openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", key,
        "-out", cert, "-subj", "/CN=127.0.0.1", "-days", "1",
    ], check=True, stderr=subprocess.DEVNULL)
    rows = []
    try:
        for variant, path in paths.items():
            subprocess.run([
                "bun", str(path / "node_modules/vite/bin/vite.js"), "build", "--mode", "production",
                "--outDir", "playwright-dist",
            ], cwd=path / "apps/web", env={**env, "VITE_API_ORIGIN": f"https://127.0.0.1:{port + 1}"},
                check=True)
        for pair in range(PAIRS):
            observations = {}
            phases = {}
            order = list(paths) if pair % 2 == 0 else list(reversed(paths))
            for variant in order:
                cell = destination / f"{pair}-{variant}"
                cell.mkdir()
                observations[variant] = run.observation(paths[variant], env, cell, "do")
                phases[variant] = evidence(cell, observations[variant])
            assert run.equivalence(observations["baseline"]) == run.equivalence(observations["candidate"]), pair
            row = {"pair": pair, "order": order, **phases}
            rows.append(row)
            with (destination / "samples.jsonl").open("a") as out:
                out.write(json.dumps(row) + "\n")
            print(json.dumps(row), flush=True)
        report = summarize(rows)
        (destination / "report.json").write_text(json.dumps(report, indent=2) + "\n")
        print(json.dumps(report, indent=2))
    finally:
        key.unlink(missing_ok=True)
        cert.unlink(missing_ok=True)


if __name__ == "__main__":
    main()
