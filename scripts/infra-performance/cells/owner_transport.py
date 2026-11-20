"""Private HTTP transport, real account analytics and independent deployed-version verification."""

import datetime as dt
import json
import os
from pathlib import Path
import re
import urllib.error
import urllib.request
from uuid import UUID

from budget import Refused, counts, today
from comparison import FIXTURE, BROWSER_FIXTURE
from prepare import PIN

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[2]
NATIVE_API = "https://storage-acceptance.fidyapp.com"
NATIVE_BROWSER = "https://storage-web-acceptance.fidyapp.com"


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
    status, _, raw = fetch(
        "https://api.cloudflare.com/client/v4/" + path,
        {
            "Authorization": "Bearer " + os.environ["CLOUDFLARE_API_TOKEN"],
            "Content-Type": "application/json",
        },
        None if body is None else json.dumps(body).encode(),
    )
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
    query = """query($account:String!,$day:Date!){viewer{accounts(filter:{accountTag:$account}){accountTag
      d1AnalyticsAdaptiveGroups(limit:1,filter:{date:$day}){sum{rowsRead rowsWritten}}}}}"""
    data = cloudflare("graphql", dict(query=query, variables=dict(account=account, day=date)))
    (group,) = data["viewer"]["accounts"]
    if group.get("accountTag") != account:
        raise Refused("Unexpected D1 analytics account")
    (result,) = group["d1AnalyticsAdaptiveGroups"]
    return dict(
        accountId=account,
        utcDate=date,
        observedAtEpochMs=int(stamp.timestamp() * 1000),
        **counts(result["sum"]),
    )


def confirmed(receipt, account, *, exposed):
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
        if (
            address.get("enabled") is not (exposed and role == "ingress")
            or address.get("previews_enabled") is not False
        ):
            raise Refused("Unexpected disposable Worker exposure")
        item = cloudflare(worker + "/deployments")["deployments"][0]
        (version,) = item["versions"]
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
    (db,) = [b for b in core.values() if b["type"] == "d1"]
    if (
        db["name"] != "DB"
        or db.get("id", db.get("database_id")) != database["uuid"]
        or db.get("database_id", database["uuid"]) != database["uuid"]
        or any(b["type"] == "d1" for b in ingress.values())
        or ingress["CORE"].get("service") != tag + "-core"
        or core["ERASURE_BUCKET"].get("bucket_name") != tag
    ):
        raise Refused("Disposable resource binding mismatch")
    namespaces = [
        core["USER_TRANSACTION_COORDINATOR"],
        core["ERASURE_REGISTRY_COORDINATOR"],
        ingress["ERASURE_REGISTRY_COORDINATOR"],
    ]
    values = {"BROWSER_ORIGIN":"https://app.fidyapp.com", "RELEASE_GIT_SHA":PIN,
              "CONTRACT_DIGEST":receipt["contractDigest"], "COMPARATOR_PACKAGE_SHA256":receipt["packageDigest"]}
    for bindings in (core, ingress):
        if any(bindings[name].get("type") != "plain_text" or bindings[name].get("text") != value
               for name, value in values.items()):
            raise Refused("Unexpected pinned release or fixture package binding")
    common = set(values)
    if (
        set(core)
        != common
        | {
            "DB",
            "ERASURE_BUCKET",
            "ERASURE_REQUIRED",
            "OPENAI_API_KEY",
            "HOSTED_AI_MODEL",
            "WHATSAPP_BUSINESS_PORTFOLIO_ID",
            "USER_TRANSACTION_COORDINATOR",
            "ERASURE_REGISTRY_COORDINATOR",
        }
        or set(ingress)
        != common
        | {
            "CORE",
            "CF_VERSION_METADATA",
            "EXPERIMENT_KEY",
            "EXPERIMENT_DEADLINE",
            "PAT_ADMISSION_KEY",
            "LOCAL_CANONICAL_READ_BEARER",
            "ERASURE_REGISTRY_COORDINATOR",
        }
        or ingress["EXPERIMENT_KEY"]["type"] != "secret_text"
        or ingress["CORE"]["type"] != "service"
    ):
        raise Refused("Unexpected protected Worker capabilities")
    for binding, role in zip(namespaces, ("core", "core", "ingress"), strict=True):
        if (
            binding["type"] != "durable_object_namespace"
            or binding["class_name"] != "UserTransactionCoordinator"
            or binding.get("namespace_id", receipt["namespaceId"]) != receipt["namespaceId"]
            or (binding.get("script_name") is not None and binding["script_name"] != tag + "-core")
            or (role == "ingress" and not binding.get("namespace_id") and binding.get("script_name") != tag + "-core")
        ):
            raise Refused("Disposable coordinator identity mismatch")
    if receipt["fixture"] not in (FIXTURE, BROWSER_FIXTURE) or receipt["baseline"] != PIN or receipt["day"] != today():
        raise Refused("Missing same-day calibrated fixture receipt")
    return "https://" + tag + "-ingress." + subdomain + ".workers.dev"
