"""Summarize complete workerd attempts, preserving open-loop offer times and paired evidence."""
import json
import math
import statistics
import sys
from collections import Counter
from pathlib import Path


def stats(values):
    if not values:
        return None
    ordered = sorted(values)
    return dict(
        median=statistics.median(ordered),
        p95=ordered[math.ceil(.95 * len(ordered)) - 1],
        maximum=ordered[-1],
        stddev=statistics.pstdev(ordered),
    )


def summarize(rows, users, samples, audit=True):
    expected = {(user, sample) for user in range(users) for sample in range(samples)}
    output, signatures = {}, {}
    complete = samples >= 30
    all_successful = True
    for variant in ("d1", "do"):
        selected = [row for row in rows if row["variant"] == variant]
        successful = [row for row in selected if row["ok"]]
        keys = Counter((row["user"], row["sample"]) for row in selected)
        complete &= keys == Counter(expected)
        all_successful &= len(successful) == len(selected)
        signatures[variant] = {(row["user"], row["sample"]): row["digest"] for row in successful}
        output[variant] = dict(
            offered=len(selected),
            expected=len(expected),
            completed=len(successful),
            dispatched=sum(row.get("dispatched") is not None for row in selected),
            failed=len(selected)-len(successful),
            incomplete=len(expected - set(signatures[variant])),
            throttled=sum(row.get("status") == 429 for row in selected),
            timeouts=sum(row.get("error") == "TimeoutError" for row in selected),
            **{key: stats([row[key] for row in successful]) for key in ("bytes", "scheduledMs", "dispatchMs")},
        )
    payloads_match = signatures["d1"] == signatures["do"] and set(signatures["d1"]) == expected
    output.update(pairedPayloadsMatch=payloads_match, auditMatches=audit, sampleCountsComplete=complete)
    for key in ("dispatchMs", "scheduledMs"):
        d1, native = (output[variant][key] for variant in ("d1", "do"))
        ratio = d1["p95"] / native["p95"] if d1 and native and native["p95"] > 0 else None
        passed = audit and payloads_match and all_successful and ratio is not None and ratio >= 1.8
        status = "missing" if not complete else "pass" if passed else "fail"
        output[key] = dict(ratio=ratio, status=status)
    return output


if __name__ == "__main__":
    directory = Path(sys.argv[1])
    plan = json.loads((directory / "plan.json").read_text())
    rows = [json.loads(line) for line in (directory / "attempts.jsonl").read_text().splitlines()]
    audit_path = directory / "audit.json"
    audits = json.loads(audit_path.read_text()) if audit_path.exists() else {}
    result = {
        cell: summarize([row for row in rows if row["cell"] == cell], users, plan["samples"], audits.get(cell) is True)
        for cell, users in (("history", plan["users"]), ("correction", 1), ("rollback", 1))
    }
    (directory / "report.json").write_text(json.dumps(result, indent=2))
    for cell, report in result.items():
        print(cell, report["scheduledMs"], report["dispatchMs"])
    sys.exit(0 if all(r["scheduledMs"]["status"] == r["dispatchMs"]["status"] == "pass" for r in result.values()) else 1)
