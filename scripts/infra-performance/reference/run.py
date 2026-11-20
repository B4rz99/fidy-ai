"""Compare the pinned D1 and native User store through the same isolated browser journey."""

import argparse
from contextlib import ExitStack, contextmanager
import hashlib
import json
import math
import os
from pathlib import Path
import platform
import re
import signal
import socket
import statistics
import subprocess
import tempfile
import time
import urllib.request

INSTRUMENTATION = "972ecaa22bb58ab472de2e9458c76290c72aa09d"
PIN = "fb53d9e755c14393048dc945fc0b7f117730d872"
HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[2]
RESULTS = ROOT / "apps/web/test-results/reference"
BROWSER = HERE / "browser.mjs"
WEB_PORT = {"d1": 4183, "do": 4173}
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
    "startup.browser",
]

READ_ONLY_BOUNDARIES = ["read.backend", "read.http", "read.browser", "startup.browser"]

CALIBRATION_VIEWS = ["budgets.month.browser", "review.pending.browser", "dashboard.fresh.browser", "recurring.month.browser", "recurring.previous.browser", "recurring.selective.browser", "recurring.no-match.browser", "recurring.full.http"]

EVENT_CELLS = {"startup.browser", "read.browser", "correction.browser", *CALIBRATION_VIEWS}


def observed_work(log):
    work = {}
    try:
        for line in log.read_text().splitlines():
            event = json.loads(line)
            journey, kind = event.get("journey"), event.get("type")
            if journey in EVENT_CELLS and kind in ("offered", "completed"):
                counts = work.setdefault(journey, {"offered": 0, "completed": 0})
                counts[kind] += 1
        return work
    except (OSError, ValueError, TypeError, KeyError):
        return None


def work_counts(key, rows):
    offered = completed = unknown = 0
    for row in rows:
        if key in row.get("timings", {}):
            # The verified result proves one dispatch/completion, including on a paired digest mismatch.
            offered += 1
            completed += 1
        elif key in EVENT_CELLS and row.get("work") is not None:
            counts = row["work"].get(key, {})
            offered += counts.get("offered", 0)
            completed += counts.get("completed", 0)
        else:
            unknown += 1
    if unknown:
        return dict(offered=None, completed=None, confirmedOffered=offered,
                    confirmedCompleted=completed, attemptsWithUnknownWork=unknown)
    return dict(offered=offered, completed=completed, incomplete=offered-completed)


# Export only controlled stage names, error classes and harness source coordinates.
STAGES = {
    "runtime", "user", "transactions", "planning", "reviews", "counts", "launch",
    "pairing", "approval", "redeem", "bootstrap", "accountability-before", "read",
    "open-correction", "save", "fresh-read", "accountability-after", "budgets-month", "review-pending", "dashboard-fixture", "dashboard-fresh", "recurring-fresh", "recurring-fixture",
}
REASONS = {
    "foreign key constraint failed": "foreign-key",
    "unique constraint failed": "unique",
    "check constraint failed": "check",
    "not null constraint failed": "not-null",
    "no such table": "missing-table",
    "no such column": "missing-column",
    "not authorized": "sqlite-authorization",
    "syntax error": "syntax",
    "assertionerror": "assertion",
    "timeouterror": "timeout",
    "could not resolve local release identity": "release-identity",
    "native directory is unavailable": "directory-readiness",
    "native worker build failed": "worker-build",
}
SOURCE_LOCATION = re.compile(
    r"/(native-seed\.ts|native\.ts|fresh-transactions\.mjs|fresh-workspaces\.mjs|fresh-dashboard\.mjs|fresh-recurring\.mjs|dev-browser-api\.ts|browser\.mjs|preview\.mjs):(\d{1,6}):(\d{1,6})\b"
)


FAILED_HTTP = re.compile(
    r"REFERENCE_HTTP (?:(GET|PUT) )?([1-5][0-9]{2})"
    r"(?: (review-history|review-summary|review-context|review-count)"
    r" (rate_limited|quota_exhausted|unclassified)"
    r" (bucket|leases|both|neither|unobserved))?"
)


def failure_metadata(log):
    if not log.exists():
        return {}
    content = log.read_text(errors="replace")
    details = {}
    for line in content.splitlines():
        if line.startswith("REFERENCE_STAGE ") and line[16:] in STAGES:
            details["stage"] = line[16:]
        match = FAILED_HTTP.fullmatch(line)
        if match:
            if match[1]:
                details["httpMethod"] = match[1]
            details["httpStatus"] = int(match[2])
            if match[3]:
                details.update(reviewResponse=match[3], errorCode=match[4],
                               pressureAfterResponse=match[5])
            break
    for message, reason in REASONS.items():
        if message in content.lower():
            details["reason"] = reason
            break
    location = SOURCE_LOCATION.search(content)
    if location:
        details["source"] = ":".join(location.groups())
    return details


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
        != subprocess.check_output(
            ["git", "show", f"{INSTRUMENTATION}:apps/server/cloudflare/{f}"], cwd=ROOT
        )
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


def prepare(api, front, port):
    end = time.monotonic() + 300
    submitted = False
    while time.monotonic() < end:
        if api.poll() is not None or front.poll() is not None:
            raise RuntimeError(f"Startup process exited (api={api.returncode}, web={front.returncode})")
        try:
            req = urllib.request.Request(f"http://127.0.0.1:{port + 2}/assessment/prepare", method="GET" if submitted else "POST")
            with urllib.request.urlopen(req, timeout=3) as response:
                status = json.load(response)["status"]
            submitted = True
            if status == "ready":
                with socket.create_connection(("127.0.0.1", port), timeout=1):
                    return
            if status == "failed":
                raise RuntimeError("Financial fixture verification failed")
        except (OSError, TimeoutError):
            pass
        time.sleep(0.2)
    raise TimeoutError("Local installation failed to prepare the comparison fixture")


def observation(path, env, destination, variant="d1"):
    with ExitStack() as stack:
        # The preview process is terminated after each observation. Own its native D1 images here.
        scratch = stack.enter_context(tempfile.TemporaryDirectory(prefix="fidy-reference-"))
        api = stack.enter_context(
            serve(
                ["bun", "apps/server/cloudflare/browser-acceptance-preview.ts" if variant == "d1"
                 else "scripts/infra-performance/reference/native.ts"],
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
        prepare(api, front, WEB_PORT[variant])
        seed = next(
            json.loads(line.removeprefix("ASSESSMENT_SEED "))
            for line in (destination / "api.log").read_text().splitlines()
            if line.startswith("ASSESSMENT_SEED ")
        )
        with (destination / "browser.log").open("w") as log:
            measure = subprocess.run(
                ["bun", str(BROWSER)],
                env={**env, "FIDY_REFERENCE_EVENTS": str(destination / "workspace-events.jsonl")},
                cwd=ROOT,
                text=True,
                stdout=subprocess.PIPE,
                stderr=log,
                timeout=150,
            )
        measure.check_returncode()
        result = json.loads(measure.stdout)
        requests = result["attempts"]
        timings = {
            "read.backend": requests[0]["backendMs"],
            "read.http": requests[0]["httpMs"],
            "read.browser": result["readMs"],
            "startup.browser": result["startupMs"],
        }
        if env.get("FIDY_REFERENCE_READ_ONLY") == "1":
            if len(requests) != 1 or "correctionMs" in result:
                raise ValueError("Unexpected mutation in read-only journey")
        else:
            timings.update({
                "correction.backend": requests[1]["backendMs"],
                "correction.http": requests[1]["httpMs"],
                "correction.fresh-read.backend": requests[2]["backendMs"],
                "correction.fresh-read.http": requests[2]["httpMs"],
                "correction.through-fresh-http": requests[2]["startEpochMs"] + requests[2]["httpMs"] - requests[1]["startEpochMs"],
                "correction.browser": result["correctionMs"],
            })
        timings.update({name: evidence["milliseconds"] for name, evidence in result["views"].items()})
        return {**result, "seed": seed, "timings": timings}


def view_fingerprints(row):
    return {name: {key: (source["status"], source["bytes"], source.get("comparableDigest", source["digest"]))
                for key, source in view.items() if key in ("http", "context")}
         for name, view in row["views"].items()}


def equivalence(row):
    return (
        {key: value for key, value in row["seed"].items() if key != "milliseconds"},
        [(attempt["status"], attempt["bytes"], attempt["payload"]) for attempt in row["attempts"]],
        view_fingerprints(row),
        row["accountability"],
        row["browser"],
    )


def compare(samples, rows, variants, *, stress=False, calibration=False, read_only=False):
    result = {}
    keys = READ_ONLY_BOUNDARIES if read_only else BOUNDARIES + (CALIBRATION_VIEWS if calibration else [])
    for key in keys:
        successful = [{row["pair"] for row in rows if row["variant"] == variant
                       and row["status"] == "ok" and key in row.get("timings", {})}
                      for variant in variants]
        comparable = set.intersection(*successful)
        cell = {}
        for variant in variants:
            attempts = [row for row in rows if row["variant"] == variant]
            values = [row["timings"][key] for row in attempts if row["pair"] in comparable]
            stats = {
                "planned": samples,
                **work_counts(key, attempts),
                "comparable": len(values),
                "failedComparisons": sum(row["status"] != "ok" for row in attempts),
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
        elif stress and all(cell[v]["comparable"] == samples for v in variants):
            status = "stress"
        elif (
            len(variants) == 2
            and samples >= 30
            and all(cell[v]["comparable"] == samples for v in variants)
        ):
            ratio = cell["d1"]["p95"] / cell["do"]["p95"]
            cell["ratio"] = ratio
            status = "pass" if ratio >= 1.8 else "fail"
        result[key] = {"status": status, **cell}
    if calibration and not read_only:
        result["recurring.full.browser"] = {"status": "not-exposed", "reason": "The product requests view=compact. Complete revisions are verified on recurring.full.http."}
    return result


def browser_workload(dataset, *, read_only=False):
    if read_only:
        return {
            "boundaries": READ_ONLY_BOUNDARIES,
            "browserStart": "Document navigation or the loaded Transactions Refresh click.",
            "browserEnd": "Ordered enabled history rows through two animation frames. Refresh additionally requires its disabled-to-enabled transition and a complete, independently verified history response.",
            "accountability": "Each refresh must add one successful audited history read, zero Corrections, zero purchased units and zero receipts.",
        }
    start = "Before document navigation or the loaded Refresh or Save interaction."
    end = ("Refresh requires search to disable then re-enable. Startup, Refresh and Save require "
           "the expected ordered rows to be visible and enabled through two animation frames.")
    if dataset != "production":
        return {"boundaries": BOUNDARIES, "browserStart": start,
                "browserEnd": end + " Payload verification follows timing."}
    return {
        "boundaries": BOUNDARIES + CALIBRATION_VIEWS,
        "browserStart": start + " Additional views start before their declared navigation, disclosure or refresh.",
        "browserEnd": end + " Budget navigation requires editable caps and fresh spending totals. "
                      "The pending review inbox requires usable rows with original excerpts. "
                      "Dashboard and Recurring require their declared populated views. The no-match Recurring search ends at the visible empty result with an enabled filter reset. Payload verification follows timing.",
        "additionalCalibrationSetup": "Four fixed Dashboard WidgetIds and one forward Recurring edit: the second plan has 3 revisions, including an intermediate revision omitted from compact responses.",
        "dashboardNormalization": ["data.context.calculatedAt"],
        "recurringHistory": "The product requests compact revisions. Its earlier-month, selective and no-match results are visible; complete revision history is checked separately through the bound canonical HTTP API.",
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--d1", required=True, type=Path)
    parser.add_argument("--do", dest="candidate", type=Path, help="clean native candidate checkout")
    parser.add_argument("--transaction-read-only", action="store_true", help="Measure only mounted Transactions startup and fresh Refresh, with real Login and one audited history query")
    parser.add_argument("--d1-browser-cost", action="store_true", help="Observe local D1 work for complete verified Chromium interactions on each fresh fixture")
    parser.add_argument("--origin", default="local loopback; geographic origin unrecorded")
    parser.add_argument("--pairs", type=int, default=1)
    parser.add_argument(
        "--dataset", choices=["production", "small", "extreme", "breaking"], default="small"
    )
    parser.add_argument("--network", choices=["normal", "poor"], default="normal")
    parser.add_argument("--setup-idle-ms", type=int, choices=[0, 2000], default=0,
                        help="Fixed idle interval after fixture preparation and before document navigation")
    args = parser.parse_args()
    if output(["bun", "--version"], ROOT) != "1.4.4":
        parser.error("Use the pinned Bun 1.4.4 toolchain")
    if args.pairs < 1:
        parser.error("--pairs must be positive")
    if args.d1_browser_cost and args.candidate:
        parser.error("D1 cost observations run independently from timing comparisons")
    paths = {"d1": args.d1.resolve()}
    if args.candidate:
        paths["do"] = args.candidate.resolve()
    revisions = {v: revision(path, v) for v, path in paths.items()}
    for port in (port for v in paths for port in range(WEB_PORT[v], WEB_PORT[v] + 3)):
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
        "FIDY_REFERENCE_READ_ONLY": "1" if args.transaction_read_only else "0",
        "FIDY_REFERENCE_D1_COST": "1" if args.d1_browser_cost else "0",
        "BROWSER_COST_MEASUREMENT": "1" if args.d1_browser_cost else "0",
        "CLI_ACCEPTANCE_MODE": "cli",
        "FIDY_ASSESSMENT": args.dataset,
        "FIDY_ASSESSMENT_NETWORK": args.network,
        "FIDY_REFERENCE_SETUP_IDLE_MS": str(args.setup_idle_ms),

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
        "postSetupIdleMs": args.setup_idle_ms,
        "d1BrowserCost": args.d1_browser_cost,
        "dataset": args.dataset,
        **browser_workload(args.dataset, read_only=args.transaction_read_only),
        "stressOnly": args.dataset == "breaking",
        "seedEpochMs": 1794916800000,
        "backendBoundary": {
            "start": "after loopback request adaptation, immediately before invoking ingress",
            "end": "complete response body buffered in the loopback API process",
            "d1": "direct ingress and Core calls in Bun; D1 binding uses Miniflare",
            "do": "Miniflare dispatchFetch to workerd ingress, Core and User store",
        },
        "lifecycle": "User and shared reconstruction unobserved",
        "warmup": "pairing and fixture preparation excluded; no measured attempts excluded",
        "harnessRevision": output(["git", "rev-parse", "HEAD"], ROOT),
        "comparisonSourceSha256": {
            f.name: hashlib.sha256(f.read_bytes()).hexdigest()
            for f in [Path(__file__), BROWSER, HERE / "fresh-transactions.mjs", HERE / "fresh-workspaces.mjs", HERE / "fresh-dashboard.mjs", HERE / "fresh-recurring.mjs", HERE / "browser-cost.mjs", HERE / "preview.mjs"]
        },
        "pairs": args.pairs,
        "order": "alternate D1-first and DO-first pairs" if args.candidate else "pinned D1 reference",
        "sampleFloor": 30,
        "percentile": "nearest-rank",
        "minimumRatio": 1.8,
        "failurePolicy": "failed attempts or unequal paired evidence fail every boundary; incomplete samples stay missing",
        "deployment": "local disposable processes and native SQLite images per variant per pair",
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
                    env={**env, "VITE_API_ORIGIN": f"https://127.0.0.1:{WEB_PORT[variant] + 1}"},
                    stdout=log,
                    stderr=log,
                    check=True,
                )
        for pair in range(args.pairs):
            paired = []
            for variant in (list(paths) if pair % 2 == 0 else list(reversed(paths))):
                destination = run / f"{pair}-{variant}"
                destination.mkdir()
                journal = destination / "workspace-events.jsonl"
                journal.touch()
                row = {"variant": variant, "pair": pair, "status": "ok"}
                try:
                    env_for_variant = {**env, "REFERENCE_WEB_PORT": str(WEB_PORT[variant])}
                    row.update(observation(paths[variant], env_for_variant, destination, variant))
                except (OSError, ValueError, RuntimeError, StopIteration, subprocess.SubprocessError) as exc:
                    diagnostics = {
                        component: metadata
                        for component in ["api", "web", "browser"]
                        if (metadata := failure_metadata(destination / f"{component}.log"))
                    }
                    row.update(status="failed", failure=type(exc).__name__, diagnostics=diagnostics)
                    if isinstance(exc, RuntimeError):
                        row["detail"] = str(exc)
                    print(f"{variant} pair {pair} failed: {type(exc).__name__} {diagnostics}", flush=True)
                row["work"] = observed_work(journal)
                paired.append(row)
            if len(paired) == 2 and all(row["status"] == "ok" for row in paired):
                if equivalence(paired[0]) != equivalence(paired[1]):
                    left, right = (view_fingerprints(row) for row in paired)
                    unequal = sorted(key for key in left.keys() | right.keys() if left.get(key) != right.get(key))
                    for row in paired:
                        row.update(status="failed", failure="fixture, payload or accountability mismatch", unequalViews=unequal)
            rows.extend(paired)
            with (run / "attempts.jsonl").open("a") as out:
                for row in paired:
                    out.write(json.dumps(row) + "\n")
    finally:
        key.unlink(missing_ok=True)
        cert.unlink(missing_ok=True)
        report = compare(args.pairs, rows, paths, stress=args.dataset == "breaking", calibration=args.dataset == "production", read_only=args.transaction_read_only)
        (run / "report.json").write_text(json.dumps(report, indent=2))
    if any(row["status"] != "ok" for row in rows) or any(
        cell["status"] == "fail" for cell in report.values()
    ):
        raise SystemExit(1)


if __name__ == "__main__":
    main()
