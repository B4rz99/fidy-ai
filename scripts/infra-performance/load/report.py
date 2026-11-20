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


def offered_schedule(rows, users, samples, native_only):
    """Check the 1 Hz per-User offers and completed, balanced blocks using the raw host clock."""
    stamps = ("scheduled", "dispatched", "completedAt")
    if any(not all(isinstance(r.get(k), (int, float)) and math.isfinite(r[k])
                   for k in stamps) for r in rows):
        return None
    half = samples // 2
    previous_end = -math.inf
    blocks = (("do",), ("do",)) if native_only else (("d1", "do"), ("do", "d1"))
    for block, order in enumerate(blocks):
        for variant in order:
            selected = [r for r in rows if r["variant"] == variant and r["sample"] // half == block]
            first = next((r for r in selected if r["user"] == 0 and r["sample"] == block * half), None)
            if first is None:
                return None
            start = first["scheduled"]
            if start < previous_end:
                return False
            for row in selected:
                due = start + row["sample"] % half * 1000 + row["user"] * 1000 / users
                if not math.isclose(row["scheduled"], due, rel_tol=0, abs_tol=.001):
                    return False
                if row["dispatched"] < due or row["completedAt"] < row["dispatched"]:
                    return False
                if row["ok"] and not all(
                    math.isclose(row[key], row["completedAt"] - row[stamp], rel_tol=0, abs_tol=.001)
                    for key, stamp in (("dispatchMs", "dispatched"), ("scheduledMs", "scheduled"))
                ):
                    return False
            previous_end = max(r["completedAt"] for r in selected)
    return True


def history_spans(rows, spans):
    """Match the very same slow dispatches to the full public/Core operation telemetry."""
    matched = {(row["variant"], row["user"], row["sample"]): row["responses"][0]
               for row in spans if row["cell"] == "history" and len(row["responses"]) == 1}
    def summary(selected):
        observations = [matched.get((r["variant"], r["user"], r["sample"]), {}) for r in selected]
        both = [r for r in observations if r.get("ingressMs") is not None and r.get("coreMs") is not None]
        return dict(eligible=len(selected), matched=len(both),
                    ingressMs=stats([r["ingressMs"] for r in both]),
                    coreMs=stats([r["coreMs"] for r in both]))
    output = {}
    for variant in ("d1", "do"):
        selected = [r for r in rows if r["cell"] == "history" and r["variant"] == variant and r["ok"]]
        threshold = stats([r["dispatchMs"] for r in selected])
        tail = [r for r in selected if r["dispatchMs"] >= threshold["p95"]]
        output[variant] = dict(**summary(selected), dispatchTail=summary(tail))
    return output


def summarize(rows, users, samples, audit=True, fixture=True, offered_history=False, native_only=False):
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
        delays = [r["dispatched"] - r["scheduled"] for r in selected
                  if r.get("dispatched") is not None and r.get("scheduled") is not None]
        output[variant] = dict(
            sampleCountsComplete=samples >= 30 and keys == Counter(expected),
            dispatchDelayMs=stats(delays),
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
    output.update(pairedPayloadsMatch=payloads_match, auditMatches=audit, fixtureVerified=fixture, sampleCountsComplete=complete)
    schedule = True
    workload_complete = output["do"]["sampleCountsComplete"] if native_only else complete
    if offered_history:
        schedule = offered_schedule(rows, users, samples, native_only) if workload_complete else None
        output["offeredScheduleVerified"] = schedule
    if native_only:
        output["nativeWorkload"] = ("missing" if not workload_complete or schedule is None else
                                    "pass" if schedule and fixture and audit and all_successful else "fail")
    for key in ("dispatchMs", "scheduledMs"):
        d1, native = (output[variant][key] for variant in ("d1", "do"))
        ratio = d1["p95"] / native["p95"] if d1 and native and native["p95"] > 0 else None
        passed = schedule and fixture and audit and payloads_match and all_successful and ratio is not None and ratio >= 1.8
        status = "missing" if not complete or schedule is None else "pass" if passed else "fail"
        output[key] = dict(ratio=ratio, status=status)
    return output


def overlapped_responses(row):
    """Validate two successful responses whose dispatch-to-completion windows intersect."""
    responses = row.get("responses", [])
    if len(responses) != 2 or any(response.get("status") != 200 for response in responses):
        return []
    if not all(isinstance(response.get(key), (int, float)) and math.isfinite(response[key])
               for key in ("dispatched", "completedAt") for response in [row, *responses]):
        return []
    if not math.isclose(min(response["dispatched"] for response in responses),
                        row["dispatched"], rel_tol=0, abs_tol=.001):
        return []
    if not math.isclose(max(response["completedAt"] for response in responses),
                        row["completedAt"], rel_tol=0, abs_tol=.001):
        return []
    if max(response["dispatched"] for response in responses) >= min(response["completedAt"] for response in responses):
        return []
    return responses


def two_tab_evidence(report, rows, samples):
    """Apply the declared overlap gate and retain individual complete HTTP durations."""
    evidence = {}
    for variant in ("d1", "do"):
        selected = [row for row in rows if row["variant"] == variant and row["ok"]]
        pairs = [overlapped_responses(row) for row in selected]
        evidence[variant] = dict(
            overlappingPairs=sum(bool(pair) for pair in pairs),
            readDispatchMs=stats([reply["completedAt"] - reply["dispatched"]
                                  for pair in pairs for reply in pair]),
        )
    overlap_verified = all(row["overlappingPairs"] == samples for row in evidence.values())
    report["sameSessionOverlap"] = dict(verified=overlap_verified, **evidence)
    if not overlap_verified:
        for boundary in ("scheduledMs", "dispatchMs"):
            if report[boundary]["status"] == "pass":
                report[boundary]["status"] = "fail"


def two_tab_transport(rows, spans, time_origin):
    day_ms = 86_400_000
    clock_tolerance_ms = 2
    matched = {(row["variant"], row["user"], row["sample"]): row["responses"]
               for row in spans if row["cell"] == "history" and len(row["responses"]) == 2}
    output = {}
    for variant in ("d1", "do"):
        samples = []
        selected = [row for row in rows if row["variant"] == variant and row["ok"]]
        for row in selected:
            responses = overlapped_responses(row)
            spans_for_pair = matched.get((variant, row["user"], row["sample"]), [])
            phases = []
            for response, span in zip(responses, spans_for_pair):
                headers, clock, ingress, core = (response.get("headersAt"),
                    span.get("ingressFinishedClockMs"), span.get("ingressMs"), span.get("coreMs"))
                if not all(type(n) in (int, float) and math.isfinite(n)
                           for n in (headers, clock, ingress, core)):
                    break
                dispatched, completed = response["dispatched"], response["completedAt"]
                if not 0 <= core <= ingress or not 0 <= clock < day_ms or not dispatched <= headers <= completed:
                    break
                header_wall_clock = (time_origin + headers) % day_ms
                offset = (clock - header_wall_clock + day_ms / 2) % day_ms - day_ms / 2
                finish = headers + offset
                before_ingress, until_headers = finish - ingress - dispatched, headers - finish
                if min(before_ingress, until_headers) < -clock_tolerance_ms:
                    break
                phases.append(dict(
                    beforeIngressMs=before_ingress, ingressMs=ingress, coreMs=core,
                    ingressToHeadersMs=until_headers, bodyMs=completed - headers,
                ))
            if len(phases) == 2:
                samples.append(dict(sample=row["sample"], pairDispatchMs=row["dispatchMs"],
                                    firstComplete=phases[0], lastComplete=phases[1]))
        output[variant] = dict(eligible=len(selected), matched=len(samples), pairs=samples)
    return output


if __name__ == "__main__":
    directory = Path(sys.argv[1])
    plan = json.loads((directory / "plan.json").read_text())
    rows = [json.loads(line) for line in (directory / "attempts.jsonl").read_text().splitlines()]
    audit_path = directory / "audit.json"
    audits = json.loads(audit_path.read_text()) if audit_path.exists() else {}
    retention = directory / "retention.json"
    fixture = retention.exists() and json.loads(retention.read_text())["verified"] is True
    two_tabs = plan["profile"] == "two-tabs"
    cells = [("history", plan["users"])]
    if not two_tabs:
        cells.extend((("correction", 1), ("rollback", 1)))
    result = {
        cell: summarize([row for row in rows if row["cell"] == cell], users, plan["samples"], audits.get(cell) is True, fixture, offered_history=cell == "history", native_only=plan["profile"] == "native-original")
        for cell, users in cells
    }
    if two_tabs:
        two_tab_evidence(result["history"], rows, plan["samples"])
    spans_path = directory / "worker-spans.jsonl"
    if spans_path.exists():
        spans = [json.loads(line) for line in spans_path.read_text().splitlines()]
        if not two_tabs:
            result["history"]["workerSpans"] = history_spans(rows, spans)
        elif "hostTimeOriginMs" in plan:
            result["history"]["transportClocks"] = two_tab_transport(rows, spans, plan["hostTimeOriginMs"])
    (directory / "report.json").write_text(json.dumps(result, indent=2))
    for cell, report in result.items():
        print(cell, report["scheduledMs"], report["dispatchMs"])
    if plan["profile"] == "native-original":
        for cell, report in result.items():
            print(cell, "native workload", report["nativeWorkload"])
        sys.exit(0 if all(r["nativeWorkload"] == "pass" for r in result.values()) else 1)
    sys.exit(0 if all(r["scheduledMs"]["status"] == r["dispatchMs"]["status"] == "pass" for r in result.values()) else 1)
