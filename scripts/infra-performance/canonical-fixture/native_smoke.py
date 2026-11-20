"""Offer one native browser and HTTP correctness smoke under the protected receipt."""
import json
import os
from pathlib import Path
import subprocess
import time

from browser_window import native_delta, native_snapshot, route_counts
from fixture import write
from hosted import ROOT, private_file

SMOKE_ENV = ("PATH", "HOME", "RUNNER_TEMP", "BROWSER_TLS_CERT", "BROWSER_TLS_KEY", "BROWSER_TLS_PIN",
             "ASSESSMENT_CHROMIUM", "SMOKE_PROOF", "FIDY_NATIVE_FIXTURE_PUBLIC_KEY")


def smoke_environment():
    env = {key: os.environ[key] for key in SMOKE_ENV}
    for key in ("BROWSER_TLS_CERT", "BROWSER_TLS_KEY", "ASSESSMENT_CHROMIUM"):
        if not Path(env[key]).is_file():
            raise ValueError("Native smoke browser prerequisite is absent")
    return env


def reserve_smoke(owner, port, proof, allowed):
    state = owner.state
    if (state["stage"] != "receipt-verified" or state.get("comparisonOffered") is not None
            or state.get("receiptDigest") != proof["nativeReceiptDigest"]
            or port.marker_owner() != proof["resourcePrefix"]):
        raise ValueError("Native smoke requires the unoffered original receipt")
    port.guard("foreground")
    maximum_preflights = sum(count for route, count in allowed.items() if route.startswith("GET "))
    reservation = dict(refreshes=1, correction=1, staleBatch=1, authenticatedRequests=sum(allowed.values()),
                       maximumPreflights=maximum_preflights, accountingWitnessReads=2, admission="one-use")
    owner.save("receipt-verified", comparisonOffered=1, browserReservation=reservation,
               lastDispatch=int(time.time()))
    deadline = state["foregroundUntil"]
    if time.time() >= deadline:
        raise ValueError("Native smoke lease expired before dispatch")
    return deadline, maximum_preflights


def run_smoke(owner, port, proof, web, out, env):
    manifest = private_file(port.directory, "manifest.json")
    expected = {key: manifest[key] for key in ("history", "workspace")}
    session = private_file(port.directory, "native-session.json")
    allowed = route_counts(expected, refreshes=1)
    context = dict(session=session, accounting=dict(
        capture=private_file(port.directory, "native-receipt.json"), captureDigest=proof["nativeReceiptDigest"],
    ))
    deadline, maximum_preflights = reserve_smoke(owner, port, proof, allowed)
    evidence = out / "native-smoke"
    evidence.mkdir(mode=0o700)
    env = {**env, "FIDY_DIAGNOSTIC_DIR": str(evidence.resolve())}
    try:
        before = native_snapshot(context, "before", deadline, env)
        result = subprocess.run(
            ["bun", "scripts/infra-performance/hosted-browser/native-smoke.ts"], cwd=ROOT, env=env,
            text=True, timeout=max(1, min(180, deadline-time.time())),
            input=json.dumps(dict(
                deadline=int(deadline*1000), maximumPreflights=maximum_preflights,
                native=dict(session=session, revision=proof["nativeRevision"], web=web),
                expected=expected, allowed=allowed,
            )),
        )
        if result.returncode:
            raise ValueError("Native correctness driver refused")
        after = native_snapshot(context, "after", deadline, env)
    finally:
        owner.save("receipt-verified", lastDispatch=int(time.time()))
    observed = private_file(evidence, "smoke.json")
    verified = native_delta(before, after, refreshes=1)
    port.guard("foreground")
    return dict(scope="native-only hosted correctness", **observed, nativeAccounting=verified)
