"""Qualify the one interrupted successor upload using Cloudflare and GitHub reads."""

from io import BytesIO
import json
import os
from pathlib import Path
import re
import subprocess
from zipfile import ZipFile

from qualified_release import actions_get, fixture_upload, protected_archive
from successor_source import approved_plan, verified_predecessor
from owner_transport import fetch

REVISION = "de04a192c3836be0efb488b170a7b93b9f98f28f"
FAILED_RUN = "44806738835"
DIAGNOSTICS = "14662658924", "182f15ae44cd6639ce70e4a70e74b11f31b92aecf1d9c7dbf722cb267e89f2bd"
PLAN_RUN = "44806470332"
PLAN = "14662931893", "f8573c959938abf153b851fb82459758c598a080686c23dcd4117be2baadb994"
COMPATIBILITY_REVIEW = "b5b4b8149af0aad6cbd5d6f657c949d03d1f5e7d"
SMOKE = "fidy-native-smoke-" + REVISION
CORE = "fidy-native-storage-core"
INGRESS = "fidy-native-storage-ingress"
CORE_VERSION = "ba7f02c9-89fa-4990-8484-42b698854d3d"
INGRESS_VERSION = "a0339369-cd2e-4ebc-ad4e-c849c14cd836"
SMOKE_VERSION = "54c5d73f-2682-4626-85bc-f8462914b1d4"
SMOKE_DEPLOYMENT = "d17e5e28-4c47-497b-9ea9-e7e5cb2ecf8a"
QUEUE = "6f6cc9f41841481dab998e691fc10e61"
CONSUMER = "81e6a933e0544e43b38b5583c8ad0faf"
DLQ = "fidy-native-async-dead-letters"
STABLE_PROTOCOL = "87d29c622bb96d493a602d18741fa4b8532871914bc956c0560d909e4377c4f5"
CANDIDATE_PROTOCOL = "176dcf18c895cce04e5abe6dde4cc541c46bdd189b4ecfc85fec8621c672b3e3"
OWNERS = {"user", "directory", "pricing", "maintenance", "erasure"}
FAILED_STEPS = {
    "Authenticate the original release, receipt, and exact erasure": "success",
    "Inspect the scoped successor resources": "skipped",
    "Capture the exact predecessor and original financial controls": "success",
    "Upload the approved successor resources": "failure",
    "Recheck the predecessor and disposal before assigning the successors": "skipped",
    "Stage the verified successors at zero traffic": "skipped",
    "Verify the successor and seal the dormant stage": "skipped",
    "Retain successor staging coordinates": "success",
}


def archived_partial(get=actions_get):
    run, data = protected_archive(
        REVISION, *DIAGNOSTICS, prefix="native-fixture-successor-staging-diagnostics-",
        conclusions={"failure"}, get=get, workflow="native-fixture-successor-plan.yml",
    )
    inventory = json.loads(get(f"runs/{run}/attempts/1/jobs?per_page=100"))
    job, = inventory["jobs"]
    steps = [(row["name"], row["conclusion"]) for row in job["steps"] if row["name"] in FAILED_STEPS]
    if (run != FAILED_RUN or inventory["total_count"] != 1 or job["name"] != "plan"
            or job["conclusion"] != "failure" or steps != list(FAILED_STEPS.items())):
        raise ValueError("Unexpected interrupted successor operation")
    with ZipFile(BytesIO(data)) as archive:
        entries = archive.infolist()
        if (len(entries) != 2 or {entry.filename for entry in entries} != {
                "native-release.json", "native-release.json.controls"}
                or any(not 0 < entry.file_size <= 4096 for entry in entries)):
            raise ValueError("Unexpected initial successor capture evidence")
        snapshot = json.loads(archive.read("native-release.json"))
        controls = json.loads(archive.read("native-release.json.controls"))
    if controls != {"digest": fixture_upload()["controlsDigest"]}:
        raise ValueError("Archived successor controls differ")
    return snapshot


def require_source(source, plan, snapshot):
    if {key: value for key, value in plan.items() if key not in {"applied", "member", "resources"}} != source:
        raise ValueError("Approved partial successor plan differs from live predecessor")
    changes = [(row["logicalId"], row["resourceType"], row["action"]) for row in plan["resources"]
               if row["action"] != "noop"]
    expected = {
        ("Core", "Cloudflare.Worker", "update"), ("Ingress", "Cloudflare.Worker", "update"),
        ("ReleaseSmoke-" + REVISION, "Cloudflare.Worker", "create"),
        ("ReleaseSmokeQueue-" + REVISION, "Cloudflare.Queues.Queue", "create"),
        ("ReleaseSmokeWorkflowV2-" + REVISION, "Cloudflare.Workflow", "create"),
        ("ReleaseSmokeConsumer-" + REVISION, "Cloudflare.Queues.Consumer", "create"),
    }
    if len(changes) != len(expected) or set(changes) != expected:
        raise ValueError("Approved partial successor changes differ")
    expected_snapshot = {
        "revision": REVISION, "stableRevision": source["previousRevision"],
        "stableContractDigest": snapshot.get("stableContractDigest"),
        "core": {"name": CORE, "stableVersionId": source["stableCoreVersion"],
                 "deploymentId": source["stableCoreDeployment"]},
        "public": {"name": INGRESS, "stableVersionId": source["stableIngressVersion"],
                   "deploymentId": source["stableIngressDeployment"]},
    }
    if snapshot != expected_snapshot or not re.fullmatch("[0-9a-f]{64}", snapshot["stableContractDigest"] or ""):
        raise ValueError("Failed capture differs from the exact old traffic positions")


def read_result(read, path):
    status, document = read(path)
    if status != 200 or document.get("success") is not True:
        raise ValueError("Could not confirm a partial successor resource")
    return document["result"]


def bindings_for(version, expected):
    rows = version["resources"]["bindings"]
    bindings = {row["name"]: row for row in rows}
    if version.get("id") != expected or len(bindings) != len(rows):
        raise ValueError("Immutable successor Worker version or bindings differ")
    return bindings


def require_workers(read, account, snapshot, source):
    base = f"accounts/{account}/workers/scripts/"
    old_smoke = "fidy-native-smoke-" + fixture_upload()["revision"]
    protocols = []
    for role, script, candidate, predecessor, deployment_id in (
            ("core", CORE, CORE_VERSION, snapshot["core"]["stableVersionId"], snapshot["core"]["deploymentId"]),
            ("public", INGRESS, INGRESS_VERSION, snapshot["public"]["stableVersionId"], snapshot["public"]["deploymentId"]),
            ("smoke", SMOKE, SMOKE_VERSION, source["oldSmokeVersionId"], SMOKE_DEPLOYMENT)):
        path = base + script
        current = read_result(read, path + "/deployments")["deployments"][0]
        expected_serving = candidate if role == "smoke" else predecessor
        live, = current["versions"]
        if (current["id"] != deployment_id or live["version_id"] != expected_serving
                or live["percentage"] != 100 or candidate == predecessor):
            raise ValueError("Live traffic differs from the unassigned partial successor")
        version = read_result(read, path + "/versions/" + candidate)
        actual = bindings_for(version, candidate)
        previous_script = old_smoke if role == "smoke" else script
        previous = read_result(read, base + previous_script + "/versions/" + predecessor)
        expected = bindings_for(previous, predecessor)
        if role != "smoke":
            protocols.append(tuple(storage_release(rows.pop("SQLITE_STORAGE_RELEASE")) for rows in (expected, actual)))
        if expected["CONTRACT_DIGEST"].get("text") != snapshot["stableContractDigest"]:
            raise ValueError("Captured stable contract digest differs")
        expected["RELEASE_GIT_SHA"] = dict(expected["RELEASE_GIT_SHA"], text=REVISION)
        if role in {"smoke", "core"}:
            expected["SMOKE_QUEUE_NAME"] = dict(expected["SMOKE_QUEUE_NAME"], text=SMOKE)
            expected["SMOKE_WORKFLOW"] = dict(expected["SMOKE_WORKFLOW"], workflow_name=SMOKE)
            if "script_name" in expected["SMOKE_WORKFLOW"]:
                expected["SMOKE_WORKFLOW"]["script_name"] = SMOKE
        if role == "core":
            expected["SMOKE_QUEUE"] = dict(expected["SMOKE_QUEUE"], queue_name=SMOKE)
            expected["NATIVE_FIXTURE_MEMBER"] = {"name": "NATIVE_FIXTURE_MEMBER", "type": "plain_text",
                                                 "text": "performance-2"}
        if role == "smoke":
            expected["ALCHEMY_WORKER_NAME"] = dict(expected["ALCHEMY_WORKER_NAME"], text=SMOKE)
        elif version.get("annotations", {}).get("workers/tag") != "release-" + FAILED_RUN + "-1":
            raise ValueError("Candidate version is not attributable to the failed upload")
        if actual != expected or actual["NATIVE_STORAGE_ADMISSION"].get("text") != "closed":
            raise ValueError("Partial successor Worker bindings differ from reviewed changes")
    if protocols[0] != protocols[1]:
        raise ValueError("Core and Ingress storage release markers differ")
    stable, candidate = protocols[0]
    if (stable["histories"] != candidate["histories"]
            or stable["protocol"] != {"write": STABLE_PROTOCOL, "readers": [STABLE_PROTOCOL]}
            or candidate["protocol"] != {"write": CANDIDATE_PROTOCOL, "readers": [CANDIDATE_PROTOCOL]}):
        raise ValueError("Storage releases differ from the audited raw protocol declarations")
    exposure = read_result(read, base + SMOKE + "/subdomain")
    if exposure.get("enabled") is not False or exposure.get("previews_enabled") is not False:
        raise ValueError("Partial smoke Worker exposure differs")


def storage_release(binding):
    if binding.get("type") != "plain_text":
        raise ValueError("Storage release binding is malformed")
    release = json.loads(binding["text"])
    if (set(release) != {"histories", "protocol"} or set(release["histories"]) != OWNERS
            or any(not isinstance(steps, list) or not steps
                   or any(not re.fullmatch(r"[0-9a-f]{64}", step) for step in steps)
                   for steps in release["histories"].values())):
        raise ValueError("Storage release migration histories are malformed")
    return release


def require_materialized_support(read, account):
    base = f"accounts/{account}/"
    queue = read_result(read, base + "queues/" + QUEUE)
    consumer, = read_result(read, base + "queues/" + QUEUE + "/consumers")
    if (queue["queue_name"] != SMOKE or queue["queue_id"] != QUEUE
            or consumer["consumer_id"] != CONSUMER or consumer["type"] != "worker"
            or consumer.get("script") != SMOKE or consumer.get("script_name", SMOKE) != SMOKE
            or consumer.get("queue_name") != SMOKE or consumer["dead_letter_queue"] != DLQ
            or any(consumer["settings"].get(key) != value for key, value in {
                "batch_size": 1, "max_retries": 3, "max_wait_time_ms": 0}.items())):
        raise ValueError("Materialized smoke Queue or consumer differs")


def require_support(read, account):
    require_materialized_support(read, account)
    base = f"accounts/{account}/"
    status, workflow = read(base + "workflows/" + SMOKE)
    if (status != 404 or workflow.get("success") is not False
            or [row["code"] for row in workflow.get("errors", [])] != [10200]):
        raise ValueError("Expected exact missing smoke Workflow")
    seen = set()
    for page in range(1, 101):
        status, response = read(base + f"workflows?per_page=100&page={page}")
        if status != 200 or response.get("success") is not True:
            raise ValueError("Could not verify the Workflow inventory")
        names = {row["name"] for row in response["result"]}
        if SMOKE in names:
            raise ValueError("Smoke Workflow unexpectedly exists in inventory")
        info = response.get("result_info") or {}
        if (info.get("page", page) != page or seen.intersection(names)
                or len(names) != len(response["result"])):
            raise ValueError("Detected inconsistent Workflow inventory")
        seen.update(names)
        last_page = info.get("total_pages")
        if (page >= last_page if last_page is not None else len(names) < 100):
            if info.get("total_count", len(seen)) != len(seen):
                raise ValueError("Could not verify the complete Workflow inventory")
            return
    raise ValueError("Workflow inventory exceeded the read-only bound")


def verified_partial_graph():
    git = ["git", "-C", str(Path(__file__).resolve().parents[3])]
    verifier = subprocess.check_output([*git, "rev-parse", "HEAD"], text=True).strip()
    if any(subprocess.run([*git, "merge-base", "--is-ancestor", revision, verifier],
                          check=False).returncode != 0 for revision in (REVISION, COMPATIBILITY_REVIEW)):
        raise ValueError("Requires the interrupted source and reviewed verifier lineage")
    account, public_key = os.environ["CLOUDFLARE_ACCOUNT_ID"], os.environ["FIDY_NATIVE_FIXTURE_PUBLIC_KEY"]
    snapshot = archived_partial()
    plan = approved_plan(REVISION, *PLAN, expected_run=PLAN_RUN)
    source = verified_predecessor(REVISION, account, public_key)
    require_source(source, plan, snapshot)

    def read(path):
        status, _, raw = fetch("https://api.cloudflare.com/client/v4/" + path,
                               {"Authorization": "Bearer " + os.environ["CLOUDFLARE_API_TOKEN"]})
        return status, json.loads(raw)

    require_workers(read, account, snapshot, source)
    return verifier, account, read, source, snapshot


def main():
    verifier, account, read, _, _ = verified_partial_graph()
    require_support(read, account)
    print(json.dumps({"verifierRevision": verifier, "candidateRevision": REVISION,
                      "failedRun": FAILED_RUN, "planRun": PLAN_RUN,
                      "applied": False, "recoveryReady": False, "candidateTraffic": 0,
                      "missing": ["Smoke Workflow"],
                      "rawProtocolReadersOverlap": False,
                      "compatibilityReviewRevision": COMPATIBILITY_REVIEW}))


if __name__ == "__main__":
    main()
