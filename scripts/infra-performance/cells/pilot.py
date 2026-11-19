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
        settings[role] = {b["name"]: b for b in cloudflare(worker + "/settings")["bindings"]}
        item = cloudflare(worker + "/deployments")["deployments"][0]
        version, = item["versions"]
        if version["version_id"] != receipt["versions"][role] or version["percentage"] != 100:
            raise Refused("Disposable Worker version mismatch")
    database = cloudflare(base + "/d1/database/" + str(UUID(receipt["databaseId"])))
    if database["name"] != tag or database["uuid"] != receipt["databaseId"]:
        raise Refused("Unexpected D1 database")
    core, ingress = settings["core"], settings["ingress"]
    db, = [b for b in core.values() if b["type"] == "d1"]
    if (db["name"] != "DB" or db["database_id"] != database["uuid"]
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


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--prepared", type=Path, required=True, help="Protected deployment and prior-cost receipt")
    parser.add_argument("--bundle", type=Path, required=True, help="Verified offline comparator artifact")
    parser.add_argument("--ledger", type=Path, required=True, help="Persistent account ledger used by provisioning")
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()
    receipt = json.loads(args.prepared.read_text())
    report = {"status": "missing", "scope": "one hosted Transactions pilot", "attempts": [], "lifecycle": "unobserved"}
    if not re.fullmatch(r"[a-f0-9]{32}", account := os.environ["CLOUDFLARE_ACCOUNT_ID"]):
        raise Refused("Invalid account")
    args.out.mkdir(parents=True, exist_ok=False)
    def save():
        (args.out / "report.json").write_text(json.dumps(report, indent=2))
    save()
    try:
        api = confirmed(receipt, account)
        manifest = json.loads((args.bundle / "manifest.json").read_bytes())
        if manifest["baseline"] != PIN or receipt["bundleSha256"] != manifest["sha256"]:
            raise Refused("Pinned comparator mismatch")
        raw = (args.bundle / "limits.json").read_bytes()
        if hashlib.sha256(raw).hexdigest() != manifest["sha256"]["limits"]:
            raise Refused("Native budget digest mismatch")
        cap = counts(json.loads(raw)["GET " + PATH]["maximum"])
        state = json.loads((args.ledger / account / "ledger.json").read_text())
        spent = counts(state["spent"])
        if (state["day"] != today() or state["pending"] is not None or not all(spent.values())
                or spent != counts(receipt["spentThroughSetup"])):
            raise Refused("Provisioning and this run must share the same reconciled ledger")
        decision = admit(ROOT, account, usage(account), {k: spent[k]+cap[k] for k in cap})
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
        save()
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
