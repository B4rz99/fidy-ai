import json
import sys
from collections import defaultdict
from pathlib import Path


def coverage(registered, attempts, start, end):
    by_owner = defaultdict(list)
    for attempt in attempts:
        name, at = attempt["name"], attempt["at"]
        if name in registered and max(start, registered[name]) <= at <= end:
            by_owner[name].append(at)
    gaps = {}
    attempted = 0
    for name, since in registered.items():
        if since >= end:
            continue
        observed = sorted(by_owner[name])
        attempted += bool(observed)
        bounds = [max(start, since), *observed, end]
        gaps[name] = max(b - a for a, b in zip(bounds, bounds[1:]))
    return {
        "eligibleOwners": len(gaps),
        "attemptedOwners": attempted,
        "maximumGapMs": max(gaps.values(), default=None),
        "lateOwners": sorted(name for name, gap in gaps.items() if gap > 300_000),
    }


def report(events):
    plan = next((e for e in events if e["phase"] == "plan"), {})
    ticks = [e for e in events if e["phase"] == "tick"]
    result = {
        "status": "incomplete",
        "plan": plan,
        "completedTicks": len(ticks),
        "unmeasured": [
            "Deployed cron delivery, account billing, row reads and writes",
            "Aggregate Queue, Workflow and provider load with busy external obligations",
            "Hung requests and response cleanup across physical owners",
        ],
    }
    complete = next((e for e in events if e["phase"] == "complete"), None)
    inventory = next((e for e in events if e["phase"] == "inventory"), None)
    if not complete or not inventory or len(ticks) != 10:
        return result
    start = inventory["start"]
    end = start + 600_000
    owners = dict.fromkeys(inventory["owners"], start)
    for e in events:
        if e["phase"] == "registered":
            owners[e["name"]] = e["at"]
    attempts = [probe for tick in ticks for probe in tick["transport"]["probes"]]
    result["rolling"] = coverage(owners, attempts, start, end)
    result["fiveMinuteWindows"] = [
        coverage(owners, attempts, a, a + 300_000) for a in [start, start + 300_000]
    ]
    result["sharedCheckMs"] = {
        name: [a["elapsedMs"] for a in attempts if a["name"] == name]
        for name in ("directory-v1", "pricing", "erasure-registry-v1")
    }
    idle = sorted(a["elapsedMs"] for a in attempts if a["name"].startswith("22610000-")
                  and a["name"] not in (complete["refusingOwner"], inventory["owners"][0])
                  and a["status"] == 204 and a["elapsedMs"] is not None)
    result["idleCheckMs"] = {
        "samples": len(idle),
        "p95": idle[(95 * len(idle) + 99) // 100 - 1] if idle else None,
        "max": max(idle, default=None),
    }
    receipt = next((e for e in events if e["phase"] == "receipt"), {})
    result["receiptExpiryObservedWithinMsOfFirstSlot"] = (
        receipt["inspectedAt"] - start if receipt.get("retained") == 0 else None
    )
    result["observed"] = sum(t["progress"]["observed"] for t in ticks)
    result["failed"] = sum(t["progress"]["failed"] for t in ticks)
    result["unknown"] = sum(t["progress"]["unknown"] for t in ticks)
    result["unsupported"] = sum(t["progress"]["unsupported"] for t in ticks)
    result["alarmRepairs"] = sum(t["progress"]["repaired"] for t in ticks)
    result["completedReceiptExpiries"] = complete["expiredReceiptsRemoved"]
    poison = complete["refusingOwner"]
    checks = {
        "inventory": len(owners) == plan["users"] + 3,
        "entireIntervalMeasured": complete["end"] >= end,
        "twoTraversals": ticks[-1]["progress"]["wraps"] >= 2,
        "everyOwnerWithinFiveMinutes": not result["rolling"]["lateOwners"],
        "everyEligibleOwnerInEachWindow": all(
            w["attemptedOwners"] == w["eligibleOwners"] for w in result["fiveMinuteWindows"]
        ),
        "actualDomainRecovery": result["completedReceiptExpiries"] == 1 and result["alarmRepairs"] >= 1,
        "failedOwnerAttempted": any(a["name"] == poison and a["status"] == 503 for a in attempts),
        "allOtherInspectionsHealthy": all(
            a["status"] == (503 if a["name"] == poison else 204) for a in attempts
        ),
        "noUnaccountedAttempts": all(
            t["progress"]["attempted"] == len(t["transport"]["probes"])
            == sum(t["progress"][k] for k in ("observed", "failed", "unsupported", "unknown"))
            for t in ticks
        ),
        "bounds": all(
            t["transport"]["peak"] <= 5 and t["transport"]["active"] == 0
            and t["elapsedMs"] <= 55_000 and len(t["transport"]["probes"]) <= 259
            for t in ticks
        ),
        "deliveredOncePerSlot": all(
            t["progress"]["scheduled"] == t["scheduled"]
            and len(t["deliveries"]) == (2 if t["slot"] == 2 else 1)
            and all(outcome == "ok" for outcome in t["deliveries"]) for t in ticks
        ),
    }
    result.update(checks=checks, status="pass" if all(checks.values()) else "fail")
    return result


if __name__ == "__main__":
    directory = Path(sys.argv[1])
    path = directory / "events.jsonl"
    rows = [json.loads(line) for line in path.read_text().splitlines()] if path.exists() else []
    result = report(rows)
    (directory / "report.json").write_text(json.dumps(result, indent=2) + "\n")
    print(json.dumps({k: v for k, v in result.items() if k != "plan"}))
    sys.exit(result["status"] != "pass")
