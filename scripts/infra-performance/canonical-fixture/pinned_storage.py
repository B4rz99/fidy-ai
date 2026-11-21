"""Compare pinned native readiness in a protected, read-only accounting dispatch."""
import json
import os
from pathlib import Path
import re
import sys
import time
from urllib.error import URLError

from installation import HOST, SCRIPTS
from successor_artifacts import OWNERS, STAGED_ACCOUNTING_ARTIFACT, main as authenticate
from owner_transport import cloudflare, fetch

FAILED_PROMOTION_RUN = "44840470010"
FAILED_PROMOTION_WINDOW = (1795219080000, 1795219140000)
OUTCOMES = {"ok", "exception", "exceededCpu", "exceededMemory", "canceled", "unknown"}
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


def probe(kind, pair, proof):
    overrides = ", ".join(f'{SCRIPTS[role]}="{pair[role]}"' for role in ("ingress", "core"))
    try:
        status, headers, raw = fetch(f"https://{HOST}/internal/release-smoke?{PROBES[kind]}",
                                     {"x-fidy-smoke-proof": proof, "cloudflare-workers-version-overrides": overrides})
    except (OSError, URLError, ValueError):
        return {"transport": "unavailable"}
    return {"status": status, "ingressMatches": headers.get("x-fidy-smoke-worker-version") == pair["ingress"],
            **inspect_body(raw, pair["revision"], pair["core"])}


def aggregate_outcome(row):
    group, = row["groups"]
    outcome = group["value"]
    if group["key"] != "$workers.outcome" or not isinstance(outcome, str):
        raise ValueError("Unexpected Worker observation group")
    count, sampling = row["count"], row["sampleInterval"]
    if (type(count) not in (float, int) or not 0 <= count <= 1_000_000_000
            or type(sampling) not in (float, int) or not 1 <= sampling <= 1_000_000_000):
        raise ValueError("Unexpected Worker observation count")
    return {"outcome": outcome if outcome in OUTCOMES else "other",
            "estimatedEvents": count, "sampled": sampling > 1}


def observation(send, account, headers, script, version, start, end):
    filters = [{"key": key, "type": "string", "operation": "eq", "value": expected}
               for key, expected in (("$workers.scriptName", script), ("$workers.scriptVersion.id", version))]
    request = {"view": "calculations", "dry": True, "timeframe": {"from": start, "to": end},
               "parameters": {"filterCombination": "and", "filters": filters, "limit": 16,
                              "groupBys": [{"type": "string", "value": "$workers.outcome"}],
                              "calculations": [{"operator": "count", "alias": "events"}]}}
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
        results = payload["result"]["calculations"]
        if results == []:
            outcomes = []
        else:
            calculation, = results
            if calculation["alias"] != "events" or len(calculation["aggregates"]) >= 16:
                raise ValueError("Unexpected or incomplete calculation")
            outcomes = [aggregate_outcome(row) for row in calculation["aggregates"]]
    except (KeyError, TypeError, ValueError, UnicodeError):
        return {"status": status, "availability": "unexpected-calculation"}
    return {"status": status, "availability": "available", "outcomes": outcomes}


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
    end = max(start + 1, int(time.time() * 1000))
    headers = {"Authorization": "Bearer " + token, "Content-Type": "application/json"}
    observations = {}
    for label, run, window in (("priorFailedPromotion", FAILED_PROMOTION_RUN, FAILED_PROMOTION_WINDOW),
                               ("currentProbes", os.environ.get("GITHUB_RUN_ID"), (start, end))):
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
