"""Admit a read-only plan from the exact successful release and disposed original fixture."""
from io import BytesIO
import json
import os
from pathlib import Path
import re
import sys
from zipfile import ZipFile

from hosted import HERE
from installation import validate_candidate, validate_qualification
from qualified_release import actions_get, artifact, protected_archive, serving_graph

sys.path.insert(0, str(HERE.parent / "cells"))
from owner_cloud import Cloud
from owner_state import CustodyObject
from owner_transport import cloudflare

ORIGINAL_REVISION = "0ba692ff68c1d63da1f4a7fdb8d6df5ff1566287"
ACTIVE_ARTIFACT = "14645515552"
ACTIVE_DIGEST = "8e7d6f0d3c5f65a3a5ca0670eaa072f7707cd36b77619a93f87ccda4c6c2b15c"
ORIGINAL_FIXTURE = ("44780106580", "3b80b33a9b97d2811fc0a43dc892e9ec218b59d2",
                    "14653370035", "0a952adeddbf7b004ccce73ff912159e722d4b252a2c297c1a3a8485c8705003")
ORIGINAL_CLEANUP = ("44787794027", "ed5f3f34724e4fc8e621f5ba43475acf78123d42",
                     "14656121411", "560998b273b339e892c808efdb28f01b0bac27fe0851215f79edf4652fbbe92f")
COHORT_WORKFLOW = "native-transaction-cohort.yml"
WORKFLOW_REF = "B4rz99/fidy-ai/.github/workflows/native-fixture-successor-plan.yml@refs/heads/trunk"
STEPS = ("Admit the exact release and enroll its closed performance User",
         "Verify the signed native originals and build the materialized D1 package",
         "Run the scoped comparator under its calibrated Free ceiling",
         "Dispose only the exact performance User and verify both established survivors",
         "Retain only aggregate observations")


def archived_cohort(pin, conclusion, steps, filename, get=actions_get):
    expected_run, revision, artifact_id, digest = pin
    run, body = protected_archive(revision, artifact_id, digest, prefix="closed-native-comparison-",
                                  conclusions={conclusion}, get=get, workflow=COHORT_WORKFLOW, suffix="-1")
    if run != expected_run:
        raise ValueError("Unexpected protected cohort source")
    data = json.loads(get(f"runs/{run}/attempts/1/jobs?per_page=100"))
    job, = data["jobs"]
    observed = [(step["name"], step["conclusion"]) for step in job["steps"] if step["name"] in STEPS]
    if (data["total_count"] != 1 or job["name"] != "cohort" or job["conclusion"] != conclusion
            or observed != list(zip(STEPS, steps))):
        raise ValueError("Unexpected protected cohort job or operation")
    with ZipFile(BytesIO(body)) as archive:
        document, = [entry for entry in archive.infolist() if entry.filename == filename]
        if not 0 < document.file_size <= 16_384:
            raise ValueError("Unexpected public cohort evidence")
        return json.loads(archive.read(document))


def verify_prior_custody(proof, cleanup, installed, custody, marker, *, coordinates, original_run, cleanup_run):
    prefix = proof["resourcePrefix"]
    if (custody is None or not re.fullmatch(r"fidy-2259-[0-9a-f]{12}", prefix)
            or proof["nativeRevision"] != coordinates["revision"] or installed["revision"] != coordinates["revision"]
            or proof["member"] != "performance-1" or proof["scope"] != "hosted native fixture"
            or (proof["originals"], proof["effective"]) != (8, 7)
            or not re.fullmatch(r"[a-f0-9]{64}", proof["nativeReceiptDigest"])
            or cleanup["scope"] != "hosted native cohort" or cleanup["status"] != "disposed"
            or cleanup["physicalState"] not in ("absent", "empty") or cleanup["survivors"] != 2
            or cleanup["retainedOneUseFence"] is not True or cleanup["originalDaySettled"] is not True
            or coordinates["prefix"] != prefix or coordinates["userNamespace"] != installed["userNamespace"]
            or custody["coordinates"] != coordinates or custody["stage"] != "disposed"
            or custody["physicalState"] != cleanup["physicalState"]
            or custody.get("receiptVerified") is not True or custody.get("receiptMarkerRetained") is not True
            or custody.get("receiptDigest") != proof["nativeReceiptDigest"] or marker != prefix
            or custody["foregroundRun"] != original_run or custody.get("cleanupRun") != cleanup_run):
        raise ValueError("Original performance fixture or erasure custody differs")


def verify_live_predecessor(read, account, promotion, installed, public_key):
    versions = {"core": installed["coreVersionId"], "ingress": installed["publicVersionId"]}
    actual = validate_candidate(read, account=account, revision=ORIGINAL_REVISION,
                                versions=versions, public_key=public_key)
    validate_qualification(actual, promotion, installed)
    serving_graph(read, account, ORIGINAL_REVISION, installed)
    path = f"accounts/{account}/workers/scripts/fidy-native-storage-core/versions/{versions['core']}"
    rows = read(path)["resources"]["bindings"]
    owners = {"USER_STORE":"UserStore", "DIRECTORY":"Directory", "PRICING":"Pricing",
              "MAINTENANCE":"Maintenance", "ERASURE":"Erasure"}
    namespaces = {row["name"]:(row.get("class_name"), row.get("namespace_id")) for row in rows
                  if row.get("type") == "durable_object_namespace"}
    expected = {binding:(class_name, namespace)
                for (binding, class_name), namespace in zip(owners.items(), installed["namespaces"])}
    if len(expected) != len(owners) or namespaces != expected:
        raise ValueError("Live predecessor namespace identities differ")
    return actual


def main():
    env = os.environ
    if (env.get("GITHUB_WORKFLOW_REF") != WORKFLOW_REF or env.get("GITHUB_REF_PROTECTED") != "true"
            or env.get("GITHUB_ACTIONS") != "true" or env.get("GITHUB_EVENT_NAME") != "workflow_dispatch"
            or env.get("GITHUB_REF") != "refs/heads/trunk" or env.get("GITHUB_RUN_ATTEMPT") != "1"
            or env.get("NATIVE_STORAGE_ADMISSION") != "closed"):
        raise ValueError("Requires the original protected successor plan attempt")
    promotion, installed = artifact(ORIGINAL_REVISION, ACTIVE_ARTIFACT, ACTIVE_DIGEST)
    original = archived_cohort(ORIGINAL_FIXTURE, "failure",
                               ("success", "success", "failure", "failure", "success"), "summary.json")
    cleanup = archived_cohort(ORIGINAL_CLEANUP, "success",
                              ("skipped", "skipped", "skipped", "success", "success"), "cleanup.json")
    account = env["CLOUDFLARE_ACCOUNT_ID"]
    actual = verify_live_predecessor(cloudflare, account, promotion, installed, env["FIDY_NATIVE_FIXTURE_PUBLIC_KEY"])
    prefix = original["resourcePrefix"]
    cloud = Cloud(account, prefix)
    store = CustodyObject(account, cloud, native_revision=ORIGINAL_REVISION, read_only=True)
    marker = CustodyObject(account, cloud, native_revision=ORIGINAL_REVISION, receipt_marker=True)
    coordinates = dict(**actual, account=account, prefix=prefix, archive=ACTIVE_DIGEST)
    verify_prior_custody(original, cleanup, installed, store.read()[1], marker.read()[1],
                         coordinates=coordinates, original_run=ORIGINAL_FIXTURE[0]+"/1",
                         cleanup_run=ORIGINAL_CLEANUP[0]+"/1")
    with (Path(env["RUNNER_TEMP"]) / "fixture-successor-source.json").open("x") as evidence:
        json.dump(dict(revision=env["GITHUB_SHA"], previousRevision=ORIGINAL_REVISION,
                       previousRelease=ACTIVE_ARTIFACT, previousCleanup=ORIGINAL_CLEANUP[2],
                       signerSha256=actual["signerSha256"]), evidence)


if __name__ == "__main__":
    main()
