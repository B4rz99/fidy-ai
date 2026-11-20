"""Restore the exact zero-traffic stage inputs after a verified Workflow recovery."""
from io import BytesIO
import json
import os
from pathlib import Path
import re
from zipfile import ZipFile

from qualified_release import actions_get, fixture_upload, git_read, protected_archive
from successor_partial import (
    CORE_VERSION, FAILED_RUN, INGRESS_VERSION, PLAN, PLAN_RUN, REVISION,
    require_materialized_support, verified_partial_graph,
)
from successor_source import WORKFLOW_REF
from successor_workflow_proof import approved_current_plan, verify_saved_workflow

APPLY_WORKFLOW = "native-fixture-workflow-recovery-apply.yml"
APPLY_STEPS = [
    "Require closed admission and a protected verifier",
    "Check the reviewed edge policy",
    "Match resolved verifier and original provider dependencies",
    "Rebuild the original plan environment",
    "Recheck the exact failed upload and live partial state",
    "Authenticate the original and exact current plan archives",
    "Register only the tracked missing Workflow",
    "Verify installed Workflow ownership and unchanged traffic",
    "Retain the verified Workflow recovery",
]
RECEIPT_FIELDS = {
    "verifierRevision", "candidateRevision", "failedRun", "planRun", "approval", "stateProof",
    "instanceProof", "workflowId", "candidateTraffic", "applied", "recoveryReady",
}


def workflow_receipt(checkout, artifact_id, digest, *, get=actions_get, git=git_read):
    if not re.fullmatch(r"[1-9][0-9]{0,19}", artifact_id or ""):
        raise ValueError("Expected an exact Workflow recovery artifact")
    verifier = json.loads(get("artifacts/" + artifact_id))["workflow_run"]["head_sha"]
    if (not re.fullmatch(r"[a-f0-9]{40}", verifier or "")
            or git("merge-base", verifier, checkout) != verifier):
        raise ValueError("Workflow recovery verifier is outside the protected lineage")
    run, data = protected_archive(
        verifier, artifact_id, digest, prefix="native-workflow-recovery-applied-",
        conclusions={"success"}, get=get, workflow=APPLY_WORKFLOW,
    )
    inventory = json.loads(get(f"runs/{run}/attempts/1/jobs?per_page=100"))
    job, = inventory["jobs"]
    steps = [(item["name"], item["conclusion"]) for item in job["steps"] if item["name"] in APPLY_STEPS]
    if (inventory["total_count"] != 1 or job["name"] != "apply" or job["conclusion"] != "success"
            or steps != [(name, "success") for name in APPLY_STEPS]):
        raise ValueError("Protected Workflow repair did not complete its exact operation")
    with ZipFile(BytesIO(data)) as archive:
        member, = archive.infolist()
        if member.filename != "native-workflow-recovery-applied.json" or not 0 < member.file_size <= 8192:
            raise ValueError("Unexpected Workflow recovery receipt archive")
        receipt = json.loads(archive.read(member))
    if (set(receipt) != RECEIPT_FIELDS or receipt["verifierRevision"] != verifier
            or receipt["candidateRevision"] != REVISION or receipt["failedRun"] != FAILED_RUN
            or receipt["planRun"] != PLAN_RUN or receipt["applied"] is not True
            or receipt["recoveryReady"] is not False or type(receipt["candidateTraffic"]) is not int
            or receipt["candidateTraffic"] != 0 or set(receipt["approval"]) != {"artifactId", "sha256"}):
        raise ValueError("Workflow recovery receipt does not retain the interrupted successor")
    approved = approved_current_plan(verifier, receipt["approval"], get=get)
    return receipt, approved


def write_capture(directory, source, snapshot, receipt, checkout, artifact_id, digest):
    rows = {
        "fixture-successor-source.json": source,
        "native-release.json": snapshot,
        "native-release.json.controls": {"digest": fixture_upload()["controlsDigest"]},
        "fixture-successor-approval.json": dict(zip(("artifactId", "sha256"), PLAN)),
        "fixture-successor-resume.json": {
            "verifierRevision": checkout,
            "supportVerifierRevision": receipt["verifierRevision"],
            "supportArtifact": artifact_id,
            "supportSha256": digest,
            "coreVersionId": CORE_VERSION,
            "publicVersionId": INGRESS_VERSION,
        },
    }
    for name, contents in rows.items():
        with (directory / name).open("x") as handle:
            json.dump(contents, handle)


def main():
    env = os.environ
    if (env.get("GITHUB_WORKFLOW_REF") != WORKFLOW_REF or env.get("GITHUB_REF_PROTECTED") != "true"
            or env.get("GITHUB_ACTIONS") != "true" or env.get("GITHUB_EVENT_NAME") != "workflow_dispatch"
            or env.get("GITHUB_REF") != "refs/heads/trunk" or env.get("GITHUB_RUN_ATTEMPT") != "1"
            or env.get("NATIVE_STORAGE_ADMISSION") != "closed" or env.get("NATIVE_STORAGE_HOSTS") != "acceptance"
            or env.get("FIXTURE_RELEASE_OPERATION") != "stage-fixture-successor"
            or env.get("FIXTURE_SUCCESSOR_RESUME") != "true" or env.get("RELEASE_GIT_SHA") != REVISION
            or env.get("GITHUB_SHA") != git_read("rev-parse", "HEAD")):
        raise ValueError("Requires the protected interrupted successor stage")
    verifier = env["GITHUB_SHA"]
    artifact_id, digest = env["SUCCESSOR_WORKFLOW_ARTIFACT"], env["SUCCESSOR_WORKFLOW_DIGEST"]
    receipt, approved = workflow_receipt(verifier, artifact_id, digest)
    current, account, read, source, snapshot = verified_partial_graph()
    if current != verifier:
        raise ValueError("Interrupted successor state came from another verifier")
    require_materialized_support(read, account)
    saved = {key: receipt[key] for key in (
        "verifierRevision", "candidateRevision", "stateProof", "instanceProof", "workflowId",
    )}
    verify_saved_workflow(read, account, saved, approved)
    write_capture(Path(env["RUNNER_TEMP"]), source, snapshot, receipt, verifier, artifact_id, digest)


if __name__ == "__main__":
    main()
