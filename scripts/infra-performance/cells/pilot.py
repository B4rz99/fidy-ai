"""Collect one paired, isolated, protected read using already provisioned and budgeted synthetic Sessions."""
import argparse
import datetime as dt
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import time
import urllib.error
import urllib.request
from uuid import UUID

from budget import Ledger, Refused, admit, counts, today
from comparison import FIXTURE, boundaries, checked_history, observe
from prepare import PIN

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[2]
NATIVE_API = "https://storage-acceptance.fidyapp.com"
NATIVE_BROWSER = "https://storage-web-acceptance.fidyapp.com"
PATH = "/transactions?limit=25"


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args):
        return None


transport = urllib.request.build_opener(NoRedirect(), urllib.request.ProxyHandler({}))


def fetch(url, headers, body=None):
    req = urllib.request.Request(url, headers=headers, data=body)
    try:
        response = transport.open(req, timeout=30)
    except urllib.error.HTTPError as error:
        response = error
    with response:
        result = response.read(1_000_001)
        if len(result) > 1_000_000:
            raise ValueError("Response exceeds the pilot fixture bound")
        return response.status, response.headers, result


def cloudflare(path, body=None):
    status, _, raw = fetch("https://api.cloudflare.com/client/v4/" + path,
                           {"Authorization": "Bearer " + os.environ["CLOUDFLARE_API_TOKEN"], "Content-Type": "application/json"},
                           None if body is None else json.dumps(body).encode())
    if status != 200:
        raise Refused("Cloudflare identity or usage unavailable")
    data = json.loads(raw)
    if body is not None:
        if data.get("errors"):
            raise Refused("Missing account-wide D1 analytics")
        return data["data"]
    if data.get("success") is not True:
        raise Refused("Cloudflare did not confirm resource identity")
    return data["result"]


def usage(account):
    stamp = dt.datetime.now(dt.timezone.utc)
    date = stamp.date().isoformat()
    query = """query($account:String!,$day:Date!){viewer{accounts(filter:{accountTag:$account}){
      d1AnalyticsAdaptiveGroups(limit:1,filter:{date:$day}){sum{rowsRead rowsWritten}}}}}"""
    data = cloudflare("graphql", dict(query=query, variables=dict(account=account, day=date)))
    group, = data["viewer"]["accounts"]
    result, = group["d1AnalyticsAdaptiveGroups"]
    return dict(accountId=account, utcDate=date, observedAtEpochMs=int(stamp.timestamp()*1000), **counts(result["sum"]))


def confirmed(receipt, account):
    tag = receipt["resourcePrefix"]
    if not re.fullmatch(r"fidy-2259-[0-9a-f]{12}", tag) or receipt["accountId"] != account:
        raise Refused("Unexpected disposable comparison inventory")
    base = "accounts/" + account
    subdomain = cloudflare(base + "/workers/subdomain")["subdomain"]
    if not re.fullmatch(r"[a-z0-9-]+", subdomain):
        raise Refused("Missing account Workers subdomain")
    settings = {}
    for role in ("core", "ingress"):
        worker = base + "/workers/scripts/" + tag + "-" + role
        address = cloudflare(worker + "/subdomain")
        if address.get("enabled") is not (role == "ingress") or address.get("previews_enabled") is not False:
            raise Refused("Unexpected disposable Worker exposure")
        item = cloudflare(worker + "/deployments")["deployments"][0]
        version, = item["versions"]
        if version["version_id"] != receipt["versions"][role] or version["percentage"] != 100:
            raise Refused("Disposable Worker version mismatch")
        deployed = cloudflare(worker + "/versions/" + str(UUID(version["version_id"])))
        if deployed["id"] != version["version_id"]:
            raise Refused("Cloudflare returned another Worker version")
        settings[role] = {b["name"]: b for b in deployed["resources"]["bindings"]}
    database = cloudflare(base + "/d1/database/" + str(UUID(receipt["databaseId"])))
    if database["name"] != tag or database["uuid"] != receipt["databaseId"]:
        raise Refused("Unexpected D1 database")
    core, ingress = settings["core"], settings["ingress"]
    db, = [b for b in core.values() if b["type"] == "d1"]
    if (db["name"] != "DB" or db.get("id", db.get("database_id")) != database["uuid"]
            or any(b["type"] == "d1" for b in ingress.values())
            or ingress["CORE"].get("service") != tag + "-core"
            or core["ERASURE_BUCKET"].get("bucket_name") != tag):
        raise Refused("Disposable resource binding mismatch")
    namespaces = [core["USER_TRANSACTION_COORDINATOR"], core["ERASURE_REGISTRY_COORDINATOR"], ingress["ERASURE_REGISTRY_COORDINATOR"]]
    if (not namespaces[0].get("namespace_id") or any(b.get("namespace_id") != namespaces[0]["namespace_id"]
            or b.get("class_name") != "UserTransactionCoordinator" for b in namespaces)):
        raise Refused("Disposable coordinator identity mismatch")
    if receipt["fixture"] != FIXTURE or receipt["baseline"] != PIN or receipt["day"] != today():
        raise Refused("Missing same-day calibrated fixture receipt")
    return "https://" + tag + "-ingress." + subdomain + ".workers.dev"


def pilot_estimate(verified, spent, request_maximum):
    full, prior, remaining = (counts(entry) for entry in (verified, spent, request_maximum))
    return counts({key: max(full[key], prior[key] + remaining[key]) for key in full})


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--prepared", type=Path, help="Protected deployment and prior-cost receipt")
    parser.add_argument("--bundle", type=Path, required=True, help="Verified offline comparator artifact")
    parser.add_argument("--ledger", type=Path, help="Persistent account ledger used by provisioning")
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()
    report = {"status": "missing", "scope": "one hosted Transactions pilot", "attempts": [], "lifecycle": "unobserved"}
    args.out.mkdir(parents=True, exist_ok=False)
    def save():
        (args.out / "report.json").write_text(json.dumps(report, indent=2))
    save()
    try:
        if not (args.bundle / "manifest.json").is_file():
            raise Refused("verified_bundle_missing")
        manifest = json.loads((args.bundle / "manifest.json").read_bytes())
        if manifest["baseline"] != PIN:
            raise Refused("pinned_comparator_mismatch")
        def checked_json(key):
            raw = (args.bundle / (key + ".json")).read_bytes()
            if hashlib.sha256(raw).hexdigest() != manifest["sha256"][key]:
                raise Refused("bundle_digest_mismatch")
            return json.loads(raw)
        probe = checked_json("probe")
        if probe["result"] != "passed" or probe["baseline"] != PIN or probe["fixture"] != FIXTURE:
            raise Refused("verified_rehearsal_missing")
        verified = counts(probe["fullEstimate"]["onePair"])
        report["fullEstimate"] = verified
        plan = checked_json("plan")
        canonical = plan.get("canonicalTransactionFixture")
        if canonical is not None:
            if canonical["observedOriginals"] != 8 or probe["comparedInspections"] != 8:
                raise Refused("canonical_fixture_mismatch")
            report["fixtureEvidence"] = "disposable native workerd"
        else:
            report["fixtureEvidence"] = "historical fixed originals"
        report["preparedReceipt"] = "supplied" if args.prepared else "missing"
        preliminary = subprocess.run(
            ["bun", "scripts/infra-performance/d1-budget.ts", "--estimate-only"], cwd=ROOT,
            input=json.dumps(verified), capture_output=True, text=True, timeout=15)
        verdict = json.loads(preliminary.stdout)
        if verdict == {"_tag":"Refused", "reason":"experiment_too_large"}:
            raise Refused("experiment_too_large")
        if verdict != {"_tag":"NeedsAccountObservation"}:
            raise Refused("invalid_estimate")
        if args.prepared is None or not args.prepared.is_file():
            raise Refused("protected_preparation_receipt_missing")
        if args.ledger is None or not args.ledger.is_dir():
            raise Refused("persistent_account_ledger_missing")
        if canonical is not None:
            raise Refused("hosted_source_attestations_unobserved")
        receipt = json.loads(args.prepared.read_text())
        if receipt["bundleSha256"] != manifest["sha256"]:
            raise Refused("prepared_bundle_mismatch")
        if not re.fullmatch(r"[a-f0-9]{32}", account := os.environ.get("CLOUDFLARE_ACCOUNT_ID", "")):
            raise Refused("Invalid account")
        cap = counts(checked_json("limits")["GET " + PATH]["maximum"])
        state = json.loads((args.ledger / account / "ledger.json").read_text())
        spent = counts(state["spent"])
        if (state["day"] != today() or state["pending"] is not None or not all(spent.values())
                or spent != counts(receipt["spentThroughSetup"])):
            raise Refused("Provisioning and this run must share the same reconciled ledger")
        api = confirmed(receipt, account)
        decision = admit(ROOT, account, usage(account), pilot_estimate(verified, spent, cap))
        sessions = json.loads(os.environ["FIDY_COMPARISON_SESSIONS"])
        headers = {}
        for v in ("d1", "do"):
            headers[v] = {"Cookie": sessions[v]["cookie"], "Fidy-Session-Binding": sessions[v]["binding"],
                          "Origin": NATIVE_BROWSER if v == "do" else "https://app.fidyapp.com"}
        native = subprocess.run(["bun", str(HERE / "sign.mjs")], cwd=ROOT, check=True,
                                input=json.dumps({**sessions["do"], "revision": receipt["nativeRevision"]}),
                                text=True, capture_output=True, timeout=15)
        headers["do"]["x-fidy-acceptance-proof"] = native.stdout
        headers["d1"]["x-fidy-comparison-key"] = os.environ["FIDY_COMPARISON_KEY"]
        with Ledger(args.ledger, account, decision) as budget:
            if budget.spent != spent:
                raise Refused("Account ledger changed after preflight")
            for variant in ("d1", "do"):
                def read_and_record():
                    cost = None
                    def send(_, path):
                        nonlocal cost
                        status, reply, body = fetch((api if variant == "d1" else NATIVE_API) + path, headers[variant])
                        if variant == "d1" and reply.get("x-fidy-comparison-worker") == receipt["versions"]["ingress"]:
                            cost = json.loads(reply.get("x-fidy-comparison-cost", "null"))
                        return status, reply, body
                    report["attempts"].append(observe(send, variant, 0, 0, time.monotonic(), "transactions.page", checked_history))
                    save()
                    return cost
                if variant == "d1":
                    report["d1Cost"] = budget.batch("hosted-transactions-pilot", cap, read_and_record)
                else:
                    read_and_record()
        report["boundaries"] = boundaries(report["attempts"], expected_pairs=1, users=1)
        report["status"] = "failed" if report["boundaries"]["httpMs"]["status"] == "fail" else "completed pilot"
        report.update(revisions={"d1": PIN, "do": receipt["nativeRevision"]}, fixture=FIXTURE, acceptance="missing")
        save()
        return int(report["status"] == "failed")
    except Exception as error:
        report.update(status="stopped", error=type(error).__name__)
        if isinstance(error, Refused):
            report["reason"] = str(error)
        save()
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
