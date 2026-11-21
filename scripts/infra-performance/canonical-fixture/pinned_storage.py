"""Compare pinned native readiness in a protected, read-only accounting dispatch."""
from collections import Counter
import json
import os
from pathlib import Path
import re
import sys
import time
from urllib.error import URLError
from urllib.parse import urlsplit

from installation import HOST, SCRIPTS
from successor_artifacts import OWNERS, STAGED_ACCOUNTING_ARTIFACT, main as authenticate
from native_custody import cloudflare, fetch

PASSED_STORAGE_RUN = "44835921933"
PASSED_STORAGE_WINDOW = (1795216915000, 1795216955000)
FAILED_PROMOTION_RUN = "44840470010"
FAILED_PROMOTION_WINDOW = (1795219080000, 1795219140000)
OUTCOMES = {"ok", "exception", "exceededCpu", "exceededMemory", "canceled", "unknown"}
SMOKE_FAILURE_STAGES = {
    "bancolombia_configuration",
    "bancolombia_signing",
    "bancolombia_discovery",
    "bancolombia_authentication",
    "bancolombia_token_lifecycle",
    "admission",
    "identity",
    "secrets",
    "schema",
    "storage",
    "coordinator",
    "publication",
    "probe_read",
    "probe_state",
    "platform",
    "configuration",
    "public_forwarding",
    "public_response",
    "core_response",
}
EVENT_LIMIT = 100
PROBES = {"compatibility": "storage=compatibility", "readiness": "readiness=1"}


def require_assignment(deployments, deployment, stable, candidate):
    latest = deployments["deployments"][0]
    percentages = {row["version_id"]: row["percentage"] for row in latest["versions"]}
    if latest["id"] != deployment or len(latest["versions"]) != 2 or percentages != {stable: 100, candidate: 0}:
        raise ValueError("Live assignment differs from the protected staged pair")


def inspect_body(raw, revision, version):
    if not raw:
        return {"shape": "empty"}
    try:
        payload = json.loads(raw)
    except (ValueError, UnicodeError):
        return {"shape": "non-json"}
    if isinstance(payload, dict) and payload.get("status") == "unavailable":
        reason = known_failure(payload.get("reason"))
        return {"shape": "unavailable", **({"failureReason": reason} if reason else {})}
    core = payload.get("core") if isinstance(payload, dict) else None
    if not isinstance(core, dict):
        return {"shape": "unexpected-json"}
    result = {"shape": "core-only", "coreMatches": core.get("workerVersionId") == version,
              "revisionMatches": core.get("gitRevision") == revision}
    markers = payload.get("markers")
    if isinstance(markers, dict):
        result["shape"] = "compatibility"
        result["ownerMarkers"] = {owner: valid_marker(markers.get(owner)) for owner in OWNERS}
    elif payload.get("status") == "pending" and payload.get("manifest") == {"protocolVersion": 1, "asyncWorkVersion": 1}:
        result["shape"] = "readiness"
    return result


def valid_marker(marker):
    return (isinstance(marker, dict) and isinstance(marker.get("workerVersionId"), str)
            and re.fullmatch(r"[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}", marker["workerVersionId"]) is not None
            and isinstance(marker.get("history"), list) and bool(marker["history"])
            and all(isinstance(entry, str) and re.fullmatch(r"[a-f0-9]{64}", entry) for entry in marker["history"]))


def known_failure(value):
    return value if isinstance(value, str) and value in SMOKE_FAILURE_STAGES else None


def probe(kind, pair, proof, *, pinned=True):
    headers = {"x-fidy-smoke-proof": proof}
    if pinned:
        headers["cloudflare-workers-version-overrides"] = ", ".join(
            f'{SCRIPTS[role]}="{pair[role]}"' for role in ("ingress", "core"))
    try:
        status, reply, raw = fetch(f"https://{HOST}/internal/release-smoke?{PROBES[kind]}", headers)
    except (OSError, URLError, ValueError):
        return {"transport": "unavailable"}
    result = {"status": status, "ingressMatches": reply.get("x-fidy-smoke-worker-version") == pair["ingress"],
              **inspect_body(raw, pair["revision"], pair["core"])}
    failure = known_failure(reply.get("x-fidy-smoke-failure"))
    if failure:
        result["failureStage"] = failure
    ray = re.fullmatch(r"[a-f0-9]{16}-([A-Z]{3})", reply.get("cf-ray") or "")
    if ray:
        result["colo"] = ray.group(1)
    return result


def event_route(url):
    if not isinstance(url, str):
        return "unknown"
    try:
        route = urlsplit(url)
    except ValueError:
        return "unknown"
    if route.scheme == "https" and route.netloc == "store.invalid" and route.path == "/release-readiness":
        return "ownerReadiness"
    if route.scheme != "https" or route.netloc != HOST or route.path != "/internal/release-smoke":
        return "other"
    return next((kind for kind, query in PROBES.items() if query == route.query), "releaseSmoke")


def object_value(value):
    return value if isinstance(value, dict) else {}


def summarize_events(page, script, version, start, end):
    events = page["events"]
    if not isinstance(events, list) or len(events) > EVENT_LIMIT:
        raise ValueError("Worker event window exceeds the bound")
    outcomes, statuses, routes = Counter(), Counter(), Counter()
    durable_objects = 0
    for event in events:
        worker = event["$workers"]
        if (worker["scriptName"] != script or worker["scriptVersion"]["id"] != version
                or type(event["timestamp"]) is not int or not start <= event["timestamp"] < end):
            raise ValueError("Worker event outside protected scope")
        outcome = worker.get("outcome")
        outcomes[outcome if isinstance(outcome, str) and outcome in OUTCOMES else "other"] += 1
        durable_objects += (worker.get("executionModel") == "durableObject"
                            or bool(worker.get("durableObjectId")))
        details = object_value(worker.get("event"))
        metadata = object_value(event.get("$metadata"))
        request = object_value(details.get("request"))
        routes[event_route(request.get("url", metadata.get("url")))] += 1
        response = object_value(details.get("response"))
        status = response.get("status", metadata.get("statusCode"))
        if type(status) is int and 100 <= status <= 599:
            statuses[str(status)] += 1
    complete = len(events) < EVENT_LIMIT and page.get("count", len(events)) == len(events)
    return {"availability": "available" if complete else "truncated", "events": len(events),
            "outcomes": dict(outcomes), "responseStatuses": dict(statuses), "routes": dict(routes),
            "durableObjectEvents": durable_objects}


def observation(send, account, headers, script, version, start, end):
    filters = [{"key": key, "type": "string", "operation": "eq", "value": expected}
               for key, expected in (("$workers.scriptName", script), ("$workers.scriptVersion.id", version))]
    request = {"queryId": "native-pinned-storage", "view": "events", "dry": True,
               "timeframe": {"from": start, "to": end}, "parameters": {"filters": filters, "limit": EVENT_LIMIT}}
    try:
        status, _, raw = send(f"https://api.cloudflare.com/client/v4/accounts/{account}/workers/observability/telemetry/query",
                              headers, json.dumps(request).encode())
    except (OSError, URLError, ValueError):
        return {"availability": "transport-unavailable"}
    if status != 200:
        return {"status": status, "availability": "refused"}
    try:
        payload = json.loads(raw)
        if payload["success"] is not True:
            return {"status": status, "availability": "refused"}
        return {"status": status, **summarize_events(payload["result"]["events"], script, version, start, end)}
    except (KeyError, TypeError, ValueError, UnicodeError):
        return {"status": status, "availability": "unexpected-events"}


def report(staged, account, token, proof):
    start = int(time.time() * 1000)
    snapshot = staged["snapshot"]
    pairs = {"candidate": {"revision": snapshot["revision"], "ingress": staged["publicVersionId"], "core": staged["coreVersionId"]},
             "stable": {"revision": snapshot["stableRevision"], "ingress": snapshot["public"]["stableVersionId"],
                        "core": snapshot["core"]["stableVersionId"]}}
    for role, capture_role in (("ingress", "public"), ("core", "core")):
        deployment = cloudflare(f"accounts/{account}/workers/scripts/{SCRIPTS[role]}/deployments")
        require_assignment(deployment, staged[capture_role + "DeploymentId"], pairs["stable"][role], pairs["candidate"][role])
    probes = {"candidate": {"compatibility": probe("compatibility", pairs["candidate"], proof)}}
    probes["stable"] = {kind: probe(kind, pairs["stable"], proof) for kind in PROBES}
    probes["candidateAfterStable"] = {"compatibility": probe("compatibility", pairs["candidate"], proof),
                                      "readiness": probe("readiness", pairs["candidate"], proof)}
    for label, ingress, core in (("mixed", "stable", "candidate"), ("reverseMixed", "candidate", "stable")):
        pair = {**pairs[core], "ingress": pairs[ingress]["ingress"]}
        probes[label] = {"compatibility": probe("compatibility", pair, proof)}
    probes["unversionedStable"] = {kind: probe(kind, pairs["stable"], proof, pinned=False) for kind in PROBES}
    end = max(start + 1, int(time.time() * 1000))
    headers = {"Authorization": "Bearer " + token, "Content-Type": "application/json"}
    observations = {}
    for label, run, window in (("priorPassedStorage", PASSED_STORAGE_RUN, PASSED_STORAGE_WINDOW),
                               ("priorFailedPromotion", FAILED_PROMOTION_RUN, FAILED_PROMOTION_WINDOW),
                               ("currentProbes", os.environ.get("GITHUB_RUN_ID"), (start - 30_000, end))):
        observations[label] = {
            "run": run,
            "timeframe": {"from": window[0], "to": window[1]},
            "outcomes": {name: {role: observation(fetch, account, headers, script, pair[role], *window)
                                for role, script in SCRIPTS.items()} for name, pair in pairs.items()},
        }
    return {"stageSource": STAGED_ACCOUNTING_ARTIFACT, "pairs": pairs, "probes": probes, "observability": observations}


def main():
    if os.environ.get("FIXTURE_ACCOUNTING_DIAGNOSTICS") != "true":
        raise ValueError("Protected read-only input required")
    authenticate()
    output = Path(os.environ["RUNNER_TEMP"])
    staged = json.loads((output / "native-release.json").read_bytes())
    account = os.environ["CLOUDFLARE_ACCOUNT_ID"]
    token, proof = os.environ["CLOUDFLARE_API_TOKEN"], os.environ["SMOKE_PROOF"]
    if not re.fullmatch(r"[a-f0-9]{32}", account) or not token or not proof:
        raise ValueError("Protected read-only credentials unavailable")
    with (output / "pinned-storage-diagnostics.json").open("x") as sink:
        json.dump(report(staged, account, token, proof), sink, indent=2)


if __name__ == "__main__":
    try:
        main()
    except (KeyError, TypeError, ValueError, OSError):
        sys.exit("Protected pinned storage diagnostic refused")
