"""Run the local D1 reference and optionally interleave a candidate using the same browser journey."""

import argparse
from contextlib import ExitStack, contextmanager
import hashlib
import json
import math
import os
from pathlib import Path
import platform
import signal
import socket
import statistics
import subprocess
import tempfile
import time
import urllib.request

PIN = "fb53d9e755c14393048dc945fc0b7f117730d872"
HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[2]
RESULTS = ROOT / "apps/web/test-results/reference"
BROWSER = HERE / "browser.mjs"
API = "http://127.0.0.1:4185/assessment/prepare"
FIXTURES = [
    "browser-assessment.test-fixture.ts",
    "browser-acceptance-preview.ts",
    "browser-acceptance-seed.ts",
]
BOUNDARIES = [
    "read.backend",
    "read.http",
    "read.browser",
    "correction.backend",
    "correction.http",
    "correction.fresh-read.backend",
    "correction.fresh-read.http",
    "correction.through-fresh-http",
    "correction.browser",
]


def output(args, cwd):
    return subprocess.check_output(args, cwd=cwd, text=True).strip()


def revision(path, variant):
    sha = output(["git", "rev-parse", "HEAD"], path)
    if variant == "d1" and sha != PIN:
        raise ValueError(f"D1 must use {PIN}, observed {sha}")
    changed = output(["git", "diff", "HEAD", "--name-only"], path).splitlines()
    allowed = {"apps/server/cloudflare/" + f for f in FIXTURES} if variant == "d1" else set()
    if set(changed) - allowed:
        raise ValueError(f"{variant} tracked runtime or build configuration differs from {sha}")
    if variant == "d1" and any(
        (path / "apps/server/cloudflare" / f).read_bytes()
        != (ROOT / "apps/server/cloudflare" / f).read_bytes()
        for f in FIXTURES
    ):
        raise ValueError(
            "Install the reference-only fixture instrumentation in the pinned checkout"
        )
    return sha


@contextmanager
def serve(args, cwd, env, log):
    with log.open("ab") as out:
        proc = subprocess.Popen(
            args, cwd=cwd, env=env, start_new_session=True, stdout=out, stderr=out
        )
        try:
            yield proc
        finally:
            try:
                os.killpg(proc.pid, signal.SIGTERM)
            except ProcessLookupError:
                pass
            try:
                proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                os.killpg(proc.pid, signal.SIGKILL)
                proc.wait()


def prepare(api, front):
    end = time.monotonic() + 300
    submitted = False
    while time.monotonic() < end:
        if api.poll() is not None or front.poll() is not None:
            raise RuntimeError("Local installation exited during startup")
        try:
            req = urllib.request.Request(API, method="GET" if submitted else "POST")
            with urllib.request.urlopen(req, timeout=3) as response:
                status = json.load(response)["status"]
            submitted = True
            if status == "ready":
                with socket.create_connection(("127.0.0.1", 4183), timeout=1):
                    return
            if status == "failed":
                raise RuntimeError("Financial fixture verification failed")
        except (OSError, TimeoutError):
            pass
        time.sleep(0.2)
    raise TimeoutError("Local installation failed to prepare the comparison fixture")


def observation(path, env, destination):
    with ExitStack() as stack:
        # The preview process is terminated after each observation. Own its native D1 images here.
        scratch = stack.enter_context(tempfile.TemporaryDirectory(prefix="fidy-reference-"))
        api = stack.enter_context(
            serve(
                ["bun", "apps/server/cloudflare/browser-acceptance-preview.ts"],
                path,
                {**env, "TMPDIR": scratch, "TEMP": scratch, "TMP": scratch},
                destination / "api.log",
            )
        )
        front = stack.enter_context(
            serve(
                ["bun", str(HERE / "preview.mjs")], path / "apps/web", env, destination / "web.log"
            )
        )
        prepare(api, front)
        seed = next(
            json.loads(line.removeprefix("ASSESSMENT_SEED "))
            for line in (destination / "api.log").read_text().splitlines()
            if line.startswith("ASSESSMENT_SEED ")
        )
        with (destination / "browser.log").open("w") as log:
            measure = subprocess.run(
                ["bun", str(BROWSER)],
                env=env,
                cwd=ROOT,
                text=True,
                stdout=subprocess.PIPE,
                stderr=log,
                timeout=150,
            )
        measure.check_returncode()
        result = json.loads(measure.stdout)
        requests = result["attempts"]
        values = [
            requests[0]["backendMs"],
            requests[0]["httpMs"],
            result["readMs"],
            requests[1]["backendMs"],
            requests[1]["httpMs"],
            requests[2]["backendMs"],
            requests[2]["httpMs"],
            requests[2]["startEpochMs"] + requests[2]["httpMs"] - requests[1]["startEpochMs"],
            result["correctionMs"],
        ]
        return {**result, "seed": seed, "timings": dict(zip(BOUNDARIES, values, strict=True))}


def compare(samples, rows, variants, *, stress=False):
    result = {}
    for key in BOUNDARIES:
        cell = {}
        for variant in variants:
            offered = [row for row in rows if row["variant"] == variant]
            values = [row["timings"][key] for row in offered if row["status"] == "ok"]
            stats = {
                "offered": len(offered),
                "completed": len(values),
                "errors": len(offered) - len(values),
            }
            if values:
                stats.update(
                    median=statistics.median(values),
                    maximum=max(values),
                    stdev=statistics.pstdev(values),
                    p95=sorted(values)[math.ceil(0.95 * len(values)) - 1],
                )
            cell[variant] = stats
        status = "missing"
        if any(row["status"] != "ok" for row in rows):
            status = "fail"
        elif stress and all(cell[v]["completed"] == samples for v in variants):
            status = "stress"
        elif (
            len(variants) == 2
            and samples >= 30
            and all(cell[v]["completed"] == samples for v in variants)
        ):
            ratio = cell["d1"]["p95"] / cell["do"]["p95"]
            cell["ratio"] = ratio
            status = "pass" if ratio >= 1.8 else "fail"
        result[key] = {"status": status, **cell}
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--d1", required=True, type=Path)
    parser.add_argument("--candidate", type=Path)
    parser.add_argument("--origin", default="local loopback; geographic origin unrecorded")
    parser.add_argument("--pairs", type=int, default=1)
    parser.add_argument(
        "--dataset", choices=["production", "small", "extreme", "breaking"], default="small"
    )
    parser.add_argument("--network", choices=["normal", "poor"], default="normal")
    args = parser.parse_args()
    if output(["bun", "--version"], ROOT) != "1.4.4":
        parser.error("Use the pinned Bun 1.4.4 toolchain")
    if args.pairs < 1:
        parser.error("--pairs must be positive")
    paths = {"d1": args.d1.resolve()}
    if args.candidate:
        paths["do"] = args.candidate.resolve()
    revisions = {name: revision(path, name) for name, path in paths.items()}
    if len(revisions) == 2 and revisions["d1"] == revisions["do"]:
        parser.error("The candidate must identify its own implementation revision")
    for port in range(4183, 4186):
        with socket.socket() as sock:
            sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            sock.bind(("127.0.0.1", port))
    run = RESULTS / str(time.time_ns())
    run.mkdir(parents=True)
    print(run, flush=True)
    key = run / "tls.key"
    cert = run / "tls.crt"
    env = {
        **os.environ,
        "FIDY_REFERENCE": "1",
        "CLI_ACCEPTANCE_MODE": "cli",
        "FIDY_ASSESSMENT": args.dataset,
        "FIDY_ASSESSMENT_NETWORK": args.network,
        "VITE_API_ORIGIN": "https://127.0.0.1:4184",
        "PLAYWRIGHT_TLS_KEY": str(key),
        "PLAYWRIGHT_TLS_CERT": str(cert),
    }
    plan = {
        "revisions": revisions,
        "installations": {k: str(v) for k, v in paths.items()},
        "scope": "local synthetic reference",
        "origin": args.origin,
        "host": platform.platform(),
        "bun": output(["bun", "--version"], ROOT),
        "network": args.network,
        "offeredLoad": "one isolated User, sequential",
        "dataset": args.dataset,
        "stressOnly": args.dataset == "breaking",
        "seedEpochMs": 1794916800000,
        "browserStart": "loaded Transactions workspace after fresh document bootstrap",
        "lifecycle": "User and shared reconstruction unobserved",
        "warmup": "pairing and fixture preparation excluded; no measured attempts excluded",
        "harnessRevision": output(["git", "rev-parse", "HEAD"], ROOT),
        "comparisonSourceSha256": {
            f.name: hashlib.sha256(f.read_bytes()).hexdigest()
            for f in [Path(__file__), BROWSER, HERE / "preview.mjs"]
        },
        "pairs": args.pairs,
        "order": "alternating D1-first / DO-first",
        "boundaries": BOUNDARIES,
    }
    (run / "plan.json").write_text(json.dumps(plan, indent=2))
    subprocess.run(
        [
            "openssl",
            "req",
            "-x509",
            "-newkey",
            "rsa:2048",
            "-nodes",
            "-keyout",
            key,
            "-out",
            cert,
            "-subj",
            "/CN=127.0.0.1",
            "-days",
            "1",
        ],
        check=True,
        stderr=subprocess.DEVNULL,
    )
    rows = []
    try:
        for variant, path in paths.items():
            with (run / f"build-{variant}.log").open("w") as log:
                subprocess.run(
                    [
                        "bun",
                        str(path / "node_modules/vite/bin/vite.js"),
                        "build",
                        "--mode",
                        "production",
                        "--outDir",
                        "playwright-dist",
                    ],
                    cwd=path / "apps/web",
                    env=env,
                    stdout=log,
                    stderr=log,
                    check=True,
                )
        for pair in range(args.pairs):
            pair_rows = []
            for variant in (list(paths) if pair % 2 == 0 else list(reversed(paths))):
                destination = run / f"{pair}-{variant}"
                destination.mkdir()
                row = {"variant": variant, "pair": pair, "status": "ok"}
                try:
                    row.update(observation(paths[variant], env, destination))
                except (
                    OSError,
                    ValueError,
                    RuntimeError,
                    StopIteration,
                    subprocess.SubprocessError,
                ) as exc:
                    row.update(status="failed", failure=type(exc).__name__)
                pair_rows.append(row)
            if len(pair_rows) == 2 and all(row["status"] == "ok" for row in pair_rows):
                left, right = pair_rows

                def identity(row):
                    return (
                        [r["payload"] for r in row["attempts"]],
                        row["accountability"],
                        {k: v for k, v in row["seed"].items() if k != "milliseconds"},
                    )

                if identity(left) != identity(right):
                    for row in pair_rows:
                        row.update(
                            status="failed",
                            failure="Different domain, accountability or fixture evidence",
                        )
            rows.extend(pair_rows)
            with (run / "attempts.jsonl").open("a") as out:
                out.writelines(json.dumps(row) + "\n" for row in pair_rows)
    finally:
        key.unlink(missing_ok=True)
        cert.unlink(missing_ok=True)
        report = compare(args.pairs, rows, paths, stress=args.dataset == "breaking")
        (run / "report.json").write_text(json.dumps(report, indent=2))
    if any(row["status"] != "ok" for row in rows) or any(
        cell["status"] == "fail" for cell in report.values()
    ):
        raise SystemExit(1)


if __name__ == "__main__":
    main()
