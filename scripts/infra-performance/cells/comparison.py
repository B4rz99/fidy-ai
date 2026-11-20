"""A comparison cell is one request shape, fixture, scenario, observed lifecycle and boundary."""
from collections import Counter
from concurrent.futures import ThreadPoolExecutor
import hashlib
import json
import math
import statistics
import time

FIXTURE = dict(transactions=8, currencies=2, effectiveTransactions=7, links=1, plans=2, revisions=4, review=4)
BROWSER_FIXTURE = {**FIXTURE, "plans":0, "revisions":0, "review":0}
READS = {
    "transactions.page": "/transactions?limit=25",
    "transactions.maximum": "/transactions?limit=100",
    "transactions.selective": "/transactions/search?q=Evaluaci%C3%B3n%202&limit=100",
    "transactions.no-match": "/transactions/search?q=does-not-exist&limit=100",
    "budgets.month": "/budget-status?month=2026-11&timeZone=America%2FBogota",
    "budgets.currency": "/budget-status?month=2026-11&timeZone=America%2FBogota&currency=USD",
    "recurring.full": "/recurring-plans?month=2026-11",
    "recurring.compact": "/recurring-plans?month=2026-11&view=compact",
    "dashboard.fresh": "/dashboard/view",
    "review.maximum": "/ingestion/review-workspace?limit=50",
    "review.counts": "/ingestion/review-workspace?limit=0",
    "review.next-page": "/ingestion/review-workspace?offset=2&limit=2&status=pending",
}
BOUNDARIES = ("httpMs", "backendMs", "scheduledMs")


def checked_history(body):
    """Independent facts from the calibrated fixture in addition to full cross-variant byte equality."""
    history = json.loads(body)["data"]
    ordinals = (0, 2, 3, 4, 5, 6, 7)
    if len(history) != len(ordinals):
        raise ValueError("wrong-page-size")
    for row, ordinal in zip(history, ordinals, strict=True):
        if (row["id"] != f"81000000-0000-4000-8000-{ordinal:012d}"
                or row["counterparty"] != f"Evaluación {ordinal}"
                or row["revision"] != 0 or row["direction"] != "outflow" or row["money"]["amount"] != "1000"
                or row["money"]["currency"] != ("USD" if ordinal % 2 else "COP")):
            raise ValueError("wrong-transaction")


def stats(values):
    ordered = sorted(values)
    return dict(count=len(values), median=statistics.median(values), max=ordered[-1],
                p95=ordered[math.ceil(.95 * len(values)) - 1], stdev=statistics.pstdev(values))


def boundaries(rows, expected_pairs, users):
    expected = {(pair, user) for pair in range(expected_pairs) for user in range(users)}
    by_variant = {v: [row for row in rows if row["variant"] == v] for v in ("d1", "do")}
    keyed = {v: {(row["pair"], row["user"]): row for row in group} for v, group in by_variant.items()}
    invalid = any(not row["ok"] for row in rows)
    for key in keyed["d1"].keys() & keyed["do"].keys():
        if keyed["d1"][key].get("digest") != keyed["do"][key].get("digest"):
            invalid = True
    complete = all(set(group) == expected and len(by_variant[v]) == len(expected)
                   for v, group in keyed.items())
    report = {}
    for field in BOUNDARIES:
        frame = {}
        for v, group in by_variant.items():
            values = [row[field] for row in group if row["ok"] and row.get(field) is not None]
            frame[v] = dict(offered=len(group), completed=len(values),
                            errors=dict(Counter(str(r.get("status", r.get("error", "unknown")))
                                                for r in group if not r["ok"])))
            if values:
                frame[v].update(stats(values))
                frame[v]["bytes"] = stats([r["bytes"] for r in group if r["ok"]])
                delays = [r["delayMs"] for r in group if r["ok"] and "delayMs" in r]
                if delays:
                    frame[v]["schedulingDelayMs"] = stats(delays)
        status = "fail" if invalid else "missing"
        if not invalid and complete and len(expected) >= 30 and all(
                g["completed"] == len(expected) and g["p95"] > 0 for g in frame.values()):
            frame["ratio"] = frame["d1"]["p95"] / frame["do"]["p95"]
            status = "pass" if frame["ratio"] >= 1.8 else "fail"
        report[field] = {**frame, "status": status}
    return report


def observe(read, variant, pair, user, due, operation, verify):
    started = time.monotonic()
    row = dict(variant=variant, pair=pair, user=user, ok=False)
    if due is not None:
        row["delayMs"] = (started - due) * 1000
    try:
        status, headers, body = read(user, READS[operation])
        ended = time.monotonic()
        row.update(status=status, bytes=len(body), digest=hashlib.sha256(body).hexdigest(),
                   httpMs=(ended - started) * 1000)
        if due is not None:
            row["scheduledMs"] = (ended - due) * 1000
        if (status != 200 or headers.get_content_type() != "application/json"
                or "no-store" not in headers.get("cache-control", "")):
            return row
        verify(body)
        backend = float(headers.get("x-reference-backend-ms", 0))
        if math.isfinite(backend) and backend > 0:
            row["backendMs"] = backend
        row["ok"] = True
    except (OSError, ValueError, IndexError, KeyError, TypeError) as error:
        row["error"] = type(error).__name__
    return row


def offers(read, variant, first, count, users, operation="transactions.page", verify=checked_history):
    """One ordinary read per second per User. Enqueue independently of replies and retain dispatch delay."""
    futures = []
    with ThreadPoolExecutor(max_workers=users * 2) as workers:
        origin = time.monotonic()
        for pair in range(first, first + count):
            for user in range(users):
                due = origin + pair - first + user / users
                time.sleep(max(0, due - time.monotonic()))
                futures.append(workers.submit(observe, read, variant, pair, user, due, operation, verify))
        return [f.result() for f in futures]
