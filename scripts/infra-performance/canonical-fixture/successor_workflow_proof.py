"""Authenticate one approved Workflow recovery and corroborate its saved Alchemy state."""

from io import BytesIO
import json
import os
from pathlib import Path
import re
import sys
from zipfile import ZipFile

from qualified_release import actions_get, protected_archive
from successor_partial import (FAILED_RUN, PLAN_RUN, REVISION, SMOKE, read_result,
                               require_materialized_support, verified_partial_graph)

WORKFLOW = "native-fixture-workflow-recovery-plan.yml"
INITIAL_VERIFIER = "07fad86fd20079e54c2c241020452d48ea8a70c2"
INITIAL_RUN = "44817202279"
INITIAL_APPROVAL = {"artifactId": "14669229524",
                    "sha256": "9ed22b7e4048b5eb53084b3f61118fa9a1d1d390da1f8459dc794d75a79d4ba6"}
PLAN_STEPS = ("Require closed admission and a protected verifier", "Check the reviewed edge policy",
              "Rebuild the original plan environment", "Recheck the exact failed upload and live partial state",
              "Inspect the existing stack without applying its plan", "Retain the read-only Workflow plan")
FILE = "native-workflow-recovery-plan.json"
OWNER_PROOFS = {"stateProof", "instanceProof"}


def protected_plan(revision, reference, get=actions_get):
    run, data = protected_archive(revision, reference["artifactId"], reference["sha256"],
                                  prefix="native-workflow-recovery-plan-", conclusions={"success"},
                                  get=get, workflow=WORKFLOW)
    inventory = json.loads(get(f"runs/{run}/attempts/1/jobs?per_page=100"))
    job, = inventory["jobs"]
    steps = [(step["name"], step["conclusion"]) for step in job["steps"] if step["name"] in PLAN_STEPS]
    if (inventory["total_count"] != 1 or job["name"] != "inspect" or job["conclusion"] != "success"
            or steps != [(name, "success") for name in PLAN_STEPS]):
        raise ValueError("Unexpected protected Workflow plan operation")
    with ZipFile(BytesIO(data)) as archive:
        entry, = archive.infolist()
        if entry.filename != FILE or not 0 < entry.file_size <= 4096:
            raise ValueError("Unexpected protected Workflow plan archive")
        return run, json.loads(archive.read(entry))


def require_approved_scope(initial_run, initial, reviewer, reviewed):
    if (initial_run != INITIAL_RUN or initial["verifierRevision"] != INITIAL_VERIFIER
            or initial["candidateRevision"] != REVISION or initial["applied"] is not False
            or initial["candidateTraffic"] != 0 or initial["recoveryReady"] is not False
            or initial["change"] != {"logicalId": "ReleaseSmokeWorkflowV2-" + REVISION,
                                     "resourceType": "Cloudflare.Workflow", "action": "create"}
            or initial["unchanged"] != ["ReleaseSmoke-" + REVISION, "ReleaseSmokeBucket",
                                       "ReleaseSmokeQueue-" + REVISION]
            or reviewed["verifierRevision"] != reviewer or reviewer == INITIAL_VERIFIER):
        raise ValueError("Protected Workflow plan source or scope differs")
    baseline = dict(initial, verifierRevision=reviewer)
    if ({key: value for key, value in reviewed.items() if key not in OWNER_PROOFS} != baseline
            or any(not re.fullmatch("[a-f0-9]{64}", reviewed.get(key, "")) for key in OWNER_PROOFS)):
        raise ValueError("Current Workflow plan or tracked instance has not been independently reviewed")


def approved_current_plan(revision, reference, get=actions_get):
    initial_run, initial = protected_plan(INITIAL_VERIFIER, INITIAL_APPROVAL, get)
    _, approved = protected_plan(revision, reference, get)
    require_approved_scope(initial_run, initial, revision, approved)
    return approved


def verify_saved_workflow(read, account, saved, approved):
    expected = {key: approved[key] for key in (
        "verifierRevision", "candidateRevision", "stateProof", "instanceProof")}
    identity = saved.get("workflowId", "")
    if ({key: value for key, value in saved.items() if key != "workflowId"} != expected
            or not re.fullmatch(r"(?:[a-f0-9]{32}|[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})", identity)):
        raise ValueError("Saved Workflow does not match the approved Alchemy state")
    workflow = read_result(read, f"accounts/{account}/workflows/{SMOKE}")
    if (workflow.get("id") != identity or workflow.get("name") != SMOKE
            or workflow.get("class_name") != "ReleaseSmokeWorkflowV2" or workflow.get("script_name") != SMOKE
            or workflow.get("schedules") not in (None, [])):
        raise ValueError("Physical Workflow does not match the saved Alchemy state")
    return identity


def main():
    env = os.environ
    revision = env["GITHUB_SHA"]
    if (env.get("GITHUB_WORKFLOW_REF") != "B4rz99/fidy-ai/.github/workflows/native-fixture-workflow-recovery-apply.yml@refs/heads/trunk"
            or env.get("GITHUB_ACTIONS") != "true" or env.get("GITHUB_REF_PROTECTED") != "true"
            or env.get("GITHUB_EVENT_NAME") != "workflow_dispatch" or env.get("GITHUB_RUN_ATTEMPT") != "1"
            or env.get("NATIVE_STORAGE_ADMISSION") != "closed" or env.get("NATIVE_STORAGE_HOSTS") != "acceptance"):
        raise ValueError("Requires the exact protected Workflow recovery")
    reference = {"artifactId": env["APPROVED_WORKFLOW_PLAN"], "sha256": env["APPROVED_WORKFLOW_PLAN_SHA256"]}
    approved = approved_current_plan(revision, reference)
    directory = Path(env["RUNNER_TEMP"])
    if sys.argv[1:] == ["approve"]:
        with (directory / "native-workflow-recovery-approved.json").open("x") as stored:
            json.dump(approved, stored)
        return
    if sys.argv[1:] != ["verify"]:
        raise ValueError("Unknown Workflow recovery proof operation")
    verifier, account, read, _, _ = verified_partial_graph()
    if verifier != revision:
        raise ValueError("Recovery verifier checkout changed")
    require_materialized_support(read, account)
    saved = json.loads((directory / "native-workflow-recovery-state.json").read_bytes())
    identity = verify_saved_workflow(read, account, saved, approved)
    with (directory / "native-workflow-recovery-applied.json").open("x") as report:
        json.dump(dict(saved, workflowId=identity, failedRun=FAILED_RUN, planRun=PLAN_RUN, approval=reference,
                       candidateTraffic=0, applied=True, recoveryReady=False), report)


if __name__ == "__main__":
    main()
