"""Authenticate the interrupted zero-traffic assignment and restore verification inputs."""

from io import BytesIO
import json
import os
from pathlib import Path
from zipfile import ZipFile

from qualified_release import actions_get, fixture_upload, git_read, protected_archive
from successor_artifacts import RESUMED_STAGE_STEPS, WORKFLOW
from successor_partial import CORE_VERSION, INGRESS_VERSION, REVISION, require_materialized_support, verified_partial_graph
from successor_resume import workflow_receipt, write_capture
from successor_source import WORKFLOW_REF
from successor_workflow_proof import verify_saved_workflow

STAGING_VERIFIER = "9c302bd359dd5f868e14720ceea40ade0c0141fe"
STAGING_RUN = "44824990400"
STAGING = {"artifactId": "14673926918", "sha256": "f5df86d3d6c140f73f3e70367a658434e797220c690e0bcb9e2cd40435036dcc"}
SUPPORT = {"artifactId": "14674261015", "sha256": "b9b961cb85c18723440e6db6fae9ca3d1b4aa5a25a4d186dc085bf6c358cd2f1"}
UPLOADS = {"coreVersionId": CORE_VERSION, "publicVersionId": INGRESS_VERSION}
ASSIGNMENTS = {"coreDeploymentId": "cf73394f-1139-4629-a51f-1a311f4a9c3e",
               "publicDeploymentId": "8645cb07-5472-4b8a-ad68-3c5eb182cd87"}
FILES = {"native-release.json", "native-release.json.uploads", "native-release.json.controls"}


def archived_staging(get=actions_get):
    run, data = protected_archive(
        STAGING_VERIFIER, STAGING["artifactId"], STAGING["sha256"],
        prefix="native-fixture-successor-staging-diagnostics-", conclusions={"failure"}, get=get, workflow=WORKFLOW,
    )
    inventory = json.loads(get(f"runs/{run}/attempts/1/jobs?per_page=100"))
    job, = inventory["jobs"]
    expected = dict(RESUMED_STAGE_STEPS)
    expected["Verify the successor and seal the dormant stage"] = "failure"
    expected["Save the zero-traffic successor seal"] = "skipped"
    actual = [(item["name"], item["conclusion"]) for item in job["steps"] if item["name"] in expected]
    if (run != STAGING_RUN or inventory["total_count"] != 1 or job["name"] != "plan"
            or job["conclusion"] != "failure" or actual != list(expected.items())):
        raise ValueError("Protected run did not assign the exact successor before failing verification")
    with ZipFile(BytesIO(data)) as archive:
        entries = archive.infolist()
        if (len(entries) != len(FILES) or {entry.filename for entry in entries} != FILES
                or any(not 0 < entry.file_size <= 4096 for entry in entries)):
            raise ValueError("Unexpected interrupted stage archive")
        files = {entry.filename: json.loads(archive.read(entry)) for entry in entries}
    release = files["native-release.json"]
    if (set(release) != {"snapshot", *UPLOADS, *ASSIGNMENTS}
            or any(release[key] != value for key, value in {**UPLOADS, **ASSIGNMENTS}.items())
            or files["native-release.json.uploads"] != UPLOADS
            or files["native-release.json.controls"] != {"digest": fixture_upload()["controlsDigest"]}):
        raise ValueError("Interrupted stage changed uploads, assignments, or financial controls")
    return release


def predecessor_view(release, read, account):
    roles = {f"accounts/{account}/workers/scripts/{release['snapshot'][role]['name']}/deployments": role
             for role in ("core", "public")}

    def verified_view(path):
        status, response = read(path)
        if path not in roles:
            return status, response
        role = roles[path]
        if status != 200 or response.get("success") is not True:
            raise ValueError("Could not confirm an exact zero-traffic assignment")
        current, previous, *_ = response["result"]["deployments"]
        stable = release["snapshot"][role]
        stable_version = (stable["stableVersionId"], 100)
        expected = {stable_version, (release[role+"VersionId"], 0)}
        actual = [(version["version_id"], version["percentage"]) for version in current["versions"]]
        prior = [(version["version_id"], version["percentage"]) for version in previous["versions"]]
        if (current["id"] != release[role+"DeploymentId"] or len(actual) != 2 or set(actual) != expected
                or previous["id"] != stable["deploymentId"] or prior != [stable_version]):
            raise ValueError(f"Exact {role} zero-traffic assignment or observed predecessor changed")
        return status, dict(response, result=dict(response["result"], deployments=[previous]))

    return verified_view


def main():
    env = os.environ
    verifier = env["GITHUB_SHA"]
    if (env.get("GITHUB_WORKFLOW_REF") != WORKFLOW_REF or env.get("GITHUB_REF_PROTECTED") != "true"
            or env.get("GITHUB_ACTIONS") != "true" or env.get("GITHUB_EVENT_NAME") != "workflow_dispatch"
            or env.get("GITHUB_REF") != "refs/heads/trunk" or env.get("GITHUB_RUN_ATTEMPT") != "1"
            or env.get("NATIVE_STORAGE_ADMISSION") != "closed" or env.get("NATIVE_STORAGE_HOSTS") != "acceptance"
            or env.get("FIXTURE_RELEASE_OPERATION") != "stage-fixture-successor"
            or env.get("FIXTURE_SUCCESSOR_RESUME") != "true" or env.get("FIXTURE_SUCCESSOR_RESEAL") != "true"
            or env.get("RELEASE_GIT_SHA") != REVISION or git_read("rev-parse", "HEAD") != verifier
            or verifier == STAGING_VERIFIER or git_read("merge-base", STAGING_VERIFIER, verifier) != STAGING_VERIFIER):
        raise ValueError("Requires the protected descendant reseal verifier")
    release = archived_staging()
    receipt, approved = workflow_receipt(verifier, SUPPORT["artifactId"], SUPPORT["sha256"])
    current, account, read, source, snapshot = verified_partial_graph(
        staged_view=lambda read, account: predecessor_view(release, read, account))
    if current != verifier or release["snapshot"] != snapshot:
        raise ValueError("Reseal stage differs from the original captured predecessor")
    require_materialized_support(read, account)
    verify_saved_workflow(read, account, {key: receipt[key] for key in (
        "verifierRevision", "candidateRevision", "stateProof", "instanceProof", "workflowId")}, approved)
    write_capture(Path(env["RUNNER_TEMP"]), source, snapshot, receipt, verifier,
                  SUPPORT["artifactId"], SUPPORT["sha256"], stage=release, reseal=STAGING)


if __name__ == "__main__":
    main()
