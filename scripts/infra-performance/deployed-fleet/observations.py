"""Reduce retained watchdog coverage logs to metadata for the installed Core version."""
import re

COVERAGE = "fidy.operational component=watchdog operation=coverage state="


def observation(query, account, version, start, end):
    filters = [{"key": key, "type": "string", "operation": op, "value": value} for key, op, value in (
        ("$workers.scriptName", "eq", "fidy-native-storage-core"),
        ("$workers.scriptVersion.id", "eq", version),
        ("$metadata.message", "includes", COVERAGE))]
    response = query(f"accounts/{account}/workers/observability/telemetry/query", {
        "queryId": "native-fleet-pilot", "view": "events",
        "timeframe": {"from": start, "to": end},
        "parameters": {"filters": filters, "limit": 100}})
    if response.get("success") is not True:
        raise ValueError("Coverage lookup refused")
    results = response["result"]["events"]
    events = results["events"]
    if len(events) >= 100 or results.get("count", len(events)) != len(events):
        raise ValueError("Coverage events truncated")
    rows = {}
    counters = ("attempted", "observed", "failed", "unknown", "unsupported", "repaired")
    for event in events:
        worker, metadata = event["$workers"], event["$metadata"]
        at = event["timestamp"]
        if (worker.get("scriptName") != "fidy-native-storage-core"
                or worker.get("scriptVersion", {}).get("id") != version
                or not start <= at < end):
            raise ValueError("Foreign event or timestamp")
        match = re.search(re.escape(COVERAGE) + r"(wrapped|capacity|deadline|cleanup)\b", metadata["message"])
        if not match:
            raise ValueError("Unrecognized watchdog outcome")
        row = {"at": at, "halt": match.group(1)}
        # Structured fields may be absent when the logger exports an unstructured line.
        source = event.get("source")
        if isinstance(source, dict) and all(type(source.get(key)) is int and source[key] >= 0 for key in counters):
            row.update({key: source[key] for key in counters})
        rows[metadata["id"]] = row
    ordered = sorted(rows.values(), key=lambda row: row["at"])
    midpoint = start + 300_000
    wraps = [row["at"] for row in ordered if row["halt"] == "wrapped"]
    return {
        "coverageEvents": ordered,
        "firstWindowTicks": sum(row["at"] < midpoint for row in ordered),
        "secondWindowTicks": sum(midpoint <= row["at"] < midpoint + 300_000 for row in ordered),
        "firstWindowWraps": sum(at < midpoint for at in wraps),
        "secondWindowWraps": sum(midpoint <= at < midpoint + 300_000 for at in wraps),
        "individualAttempts": None, "individualSuccessfulChecks": None,
        "failedOrUnknownProbes": None, "completedWatchdogRecoveries": None,
    }
