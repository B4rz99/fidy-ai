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
        rows[metadata["id"]] = {"at": at, "halt": match.group(1)}
    ordered = sorted(rows.values(), key=lambda row: row["at"])
    midpoint = start + 300_000
    return {
        "coverageEvents": ordered,
        "firstWindowTicks": sum(row["at"] < midpoint for row in ordered),
        "secondWindowTicks": sum(midpoint <= row["at"] < midpoint + 300_000 for row in ordered),
        "individualAttempts": None, "individualSuccessfulChecks": None,
        "failedOrUnknownProbes": None, "completedWatchdogRecoveries": None,
    }
