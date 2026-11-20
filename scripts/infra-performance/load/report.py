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
    return dict(median=statistics.median(ordered), p95=ordered[math.ceil(.95 * len(ordered)) - 1],
                maximum=ordered[-1], stddev=statistics.pstdev(ordered))


def summarize(rows, users, samples, audit=True):
    expected = {(user, sample) for user in range(users) for sample in range(samples)}
    output, signatures = {}, {}
    complete = True
    comparable = audit
    for variant in ("d1", "do"):
        selected = [r for r in rows if r["variant"] == variant]
        successful = [r for r in selected if r["ok"]]
        keys = Counter((r["user"], r["sample"]) for r in selected)
        complete &= keys == Counter(expected) and samples >= 30
        comparable &= len(successful) == len(selected)
        signatures[variant] = {(r["user"], r["sample"]): r["digest"] for r in successful}
        output[variant] = dict(offered=len(selected), expected=len(expected), completed=len(successful),
                               failed=len(selected)-len(successful),
                               throttled=sum(r.get("status") == 429 for r in selected),
                               timeouts=sum(r.get("error") == "TimeoutError" for r in selected),
                               **{k: stats([r[k] for r in successful]) for k in ("bytes", "scheduledMs", "dispatchMs")})
    comparable &= signatures["d1"] == signatures["do"]
    for key in ("dispatchMs", "scheduledMs"):
        a, b = (output[v][key] for v in ("d1", "do"))
        ratio = a["p95"] / b["p95"] if a and b and b["p95"] > 0 else None
        status = "missing" if not complete else "pass" if comparable and ratio and ratio >= 1.8 else "fail"
        output[key] = dict(ratio=ratio, status=status)
    return output


if __name__ == "__main__":
    directory = Path(sys.argv[1])
    rows = [json.loads(line) for line in (directory / "attempts.jsonl").read_text().splitlines()]
    audits = json.loads((directory / "audit.json").read_text()) if (directory / "audit.json").exists() else {}
    result = {cell: summarize([r for r in rows if r["cell"] == cell], users, 30, audits.get(cell) is True)
              for cell, users in (("history", 20), ("correction", 1))}
    (directory / "report.json").write_text(json.dumps(result, indent=2))
    for cell, report in result.items():
        print(cell, report["scheduledMs"], report["dispatchMs"])
    sys.exit(0 if all(r["scheduledMs"]["status"] == r["dispatchMs"]["status"] == "pass" for r in result.values()) else 1)
