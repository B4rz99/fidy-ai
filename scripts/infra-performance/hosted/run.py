"""Rehearse a pinned fixture locally. Explicit --execute runs the same batches on temporary hosted D1."""
import argparse
import datetime as dt
import fcntl
import hashlib
import json
import math
from urllib.parse import urlencode

from cloudflare import Cloudflare, count, observe
from pathlib import Path
import subprocess
import uuid

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[2]
RESULTS = ROOT / "apps/server/test-results/d1-calibration"


def bounds(batch):
    # Headroom includes the larger hosted migration scans and fixed per-batch bookkeeping.
    return {"rowsRead": math.ceil(batch["reads"] * 1.7) + 20,
            "rowsWritten": math.ceil(batch["writes"] * 1.55) + 4}


def write(path, value):
    pending = path.with_suffix(".tmp")
    pending.write_text(json.dumps(value, indent=2) + "\n")
    pending.replace(path)


KEYS = ("rowsRead", "rowsWritten")
ZERO = {"rowsRead": 0, "rowsWritten": 0}


def today():
    return dt.datetime.now(dt.timezone.utc).date().isoformat()


def utcnow():
    return dt.datetime.now(dt.timezone.utc).isoformat()


def add(a, b):
    return {k: count(a[k]) + count(b[k]) for k in KEYS}


def admit(account, observation, estimate):
    request = {"accountId": account, "observation": observation, "estimate": estimate}
    proc = subprocess.run(["bun", "scripts/infra-performance/d1-budget.ts"], cwd=ROOT,
                          input=json.dumps(request), capture_output=True, text=True, timeout=20)
    decision = json.loads(proc.stdout)
    if proc.returncode or decision["_tag"] != "Allowed":
        raise RuntimeError("Account D1 budget refused: " + decision.get("reason", "unavailable"))
    return {"rowsRead":count(decision["maximumRowsRead"]), "rowsWritten":count(decision["maximumRowsWritten"])}


def result(response):
    if response.get("success") is not True:
        raise RuntimeError("Cloudflare did not confirm the requested operation")
    return response.get("result")


def verify_target(api, target, database, name):
    identity = result(api.call("GET", target))
    if identity["uuid"] != database or identity["name"] != name:
        raise RuntimeError("Temporary database identity mismatch")


def execute(api, plan, report, path, ledger_path):
    day = today()
    ledger = json.loads(ledger_path.read_text()) if ledger_path.exists() else {}
    if ledger.get("unresolved"):
        raise RuntimeError("Previous temporary database or request still requires reconciliation")
    if ledger.get("unknownCostDay") == day:
        raise RuntimeError("Unknown D1 cost fences attempts for this UTC day")
    if ledger.get("day") != day:
        ledger = {"day": day, "spent":ZERO.copy(), "observed":{}}
    prior = ledger["spent"].copy()
    measured = ledger["observed"].get(report["planSha256"], {})
    limits = []
    estimate = prior.copy()
    for index, batch in enumerate(plan["batches"]):
        limit = bounds(batch)
        if str(index) in measured:
            # Rehearsal SQL, parameters and native metadata all match the previous plan digest.
            previous = measured[str(index)]
            limit = {"rowsRead": math.ceil(count(previous["rowsRead"])*1.1)+4,
                     "rowsWritten": math.ceil(count(previous["rowsWritten"])*1.12)+2}
        limits.append(limit)
        estimate = add(estimate, limit)
    observation = observe(api)
    report.update(
        accountId=api.account, priorConsumption=prior, observation=observation,
        fullEstimate=estimate, startedAt=utcnow(), attempts=[], actual=ZERO.copy(),
        deletionVerified=False, status="preflight",
    )
    write(path, report)
    allowance = admit(api.account, observation, estimate)
    report.update(allowance=allowance, status="started")
    base = f"accounts/{api.account}/d1/database"
    name = "fidy-2226-calibration-" + uuid.uuid4().hex
    report["name"] = name
    write(path, report)
    ledger["unresolved"] = {"name":name, "report":str(path)}
    write(ledger_path, ledger)
    created = result(api.call("POST", base, {"name":name}))
    if created["name"] != name:
        raise RuntimeError("Cloudflare did not confirm the newly created fixture")
    database = str(uuid.UUID(created["uuid"]))
    report["uuid"] = database
    write(path, report)
    target = base + "/" + database
    uncertain = False
    try:
        verify_target(api, target, database, name)
        for i, (batch, ceiling) in enumerate(zip(plan["batches"], limits, strict=True)):
            if today() != day or any(ledger["spent"][k] + ceiling[k] > allowance[k] for k in KEYS):
                raise RuntimeError("Remaining D1 budget does not admit the next batch")
            attempt = {"batch":i, "status":"started"}
            report["attempts"].append(attempt)
            write(path, report)
            uncertain = True
            returned = result(api.call("POST", target + "/query", {"batch":batch["batch"]}))
            if not isinstance(returned,list) or len(returned) != len(batch["batch"]):
                raise RuntimeError("Cloudflare returned an incomplete native batch")
            actual = ZERO.copy()
            for statement in returned:
                if statement.get("success") is not True:
                    raise RuntimeError("D1 did not confirm a statement")
                meta = statement.get("meta", {})
                actual = add(actual, {"rowsRead": count(meta.get("rows_read")), "rowsWritten": count(meta.get("rows_written"))})
            ledger["spent"] = add(ledger["spent"], actual)
            ledger["observed"].setdefault(report["planSha256"], {})[str(i)] = actual
            write(ledger_path, ledger)
            uncertain = False
            report["actual"] = add(report["actual"], actual)
            attempt.update(status="returned", **actual)
            write(path, report)
            if any(actual[k] > ceiling[k] for k in KEYS):
                raise RuntimeError(f"Native counters exceeded the bound for batch {i}")
        if returned[0]["results"] != [plan["verified"]]:
            raise RuntimeError("Hosted verification differs from the native fixture")
        report.update(hostedVerified=returned[0]["results"][0], status="passed")
    except BaseException:
        report["status"] = "failed"
        raise
    finally:
        write(path, report)
        verify_target(api, target, database, name)
        result(api.call("DELETE", target))
        matches = result(api.call("GET", base + "?" + urlencode({"name":name})))
        if matches != []:
            raise RuntimeError("Temporary database deletion remains unverified")
        report.update(deletionVerified=True, finishedAt=utcnow())
        write(path, report)
        if not uncertain:
            ledger.pop("unresolved")
        else:
            # The request may have committed. Block retries on the same UTC budget.
            ledger["unknownCostDay"] = day
            ledger.pop("unresolved")
        write(ledger_path, ledger)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--execute", action="store_true", help="Create, verify and remove a disposable hosted database")
    args = parser.parse_args()
    run_dir = RESULTS / uuid.uuid4().hex
    run_dir.mkdir(parents=True)
    plan_file = run_dir / "plan.json"
    with (run_dir / "native.log").open("wb") as log:
        subprocess.run(["bun", str(ROOT / "apps/server/scripts/prepare-d1-calibration.test-fixture.ts"), str(plan_file)], cwd=ROOT,
                       stdout=log, stderr=subprocess.STDOUT, check=True)
    plan_bytes = plan_file.read_bytes()
    plan = json.loads(plan_bytes)
    batches = plan["batches"]
    limits = [bounds(batch) for batch in batches]
    report = {
        "status": "rehearsed",
        "baseline": plan["baseline"], "seedEpochMs": plan["seedEpochMs"],
        "planSha256": hashlib.sha256(plan_bytes).hexdigest(),
        "revision": subprocess.check_output(["git","rev-parse","HEAD"], cwd=ROOT, text=True).strip(),
        "verified": plan["verified"], "batches": len(batches),
        "native": {"rowsRead":sum(b["reads"] for b in batches), "rowsWritten":sum(b["writes"] for b in batches)},
        "estimate": {key: sum(limit[key] for limit in limits) for key in ("rowsRead", "rowsWritten")},
    }
    path = run_dir / "report.json"
    write(path, report)
    print(path, flush=True)
    if args.execute:
        api = Cloudflare(ROOT)
        state = Path.home() / ".cache/fidy/d1-calibration" / api.account
        state.mkdir(parents=True, mode=0o700, exist_ok=True)
        with (state / "account.lock").open("a") as lock:
            fcntl.flock(lock.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
            try:
                execute(api, plan, report, path, state / "ledger.json")
            except BaseException as exc:
                report.update(status="failed", error=str(exc) if isinstance(exc, RuntimeError) else type(exc).__name__, finishedAt=utcnow())
                write(path, report)
                raise


if __name__ == "__main__":
    main()
