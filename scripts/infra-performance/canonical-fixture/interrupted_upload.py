"""Authenticate the original, uploaded-but-unstaged dormant release before its one-off repair."""
from io import BytesIO
import json
import os
from pathlib import Path
import re
import subprocess
from zipfile import ZipFile

from qualified_release import REPO, actions_get, protected_archive

REVISION = "aa447b8b781cdda48e021c1332f4377eae00f179"
RUN = "44680185091"
ARTIFACT = "14604061646"
ARCHIVE_DIGEST = "9412268e84f76a593ca476ab48ca053108950071f07e5679c61ef784d639758c"
CONTROLS_DIGEST = "2eee761a2ad80cc95af93019576815a2d8a7d7c8ed5d41a11cda49bb1b3f956f"

STEPS = {
    "Require closed admission in the protected environment": "success",
    "Capture the native stable pair": "success",
    "Upload the verified native candidates": "success",
    "Stage the zero-traffic native candidates": "failure",
    "Seal dormant fallback stage before promotion": "skipped",
    "Finish only the tested closed forward repair": "skipped",
    "Verify mixed and candidate versions before promoting closed admission": "skipped",
    "Retain native release evidence": "success",
}


def verify_dispatch(env, parents):
    revision = env.get("GITHUB_SHA", "")
    if (env.get("GITHUB_REPOSITORY") != REPO or env.get("GITHUB_REF") != "refs/heads/trunk"
            or env.get("GITHUB_REF_PROTECTED") != "true" or env.get("GITHUB_EVENT_NAME") != "workflow_dispatch"
            or env.get("GITHUB_RUN_ATTEMPT") != "1" or env.get("NATIVE_STORAGE_ADMISSION") != "closed"
            or env.get("NATIVE_STORAGE_HOSTS") != "acceptance" or env.get("NATIVE_FIXTURE_BUILD") != "fallback"
            or env.get("FIXTURE_RELEASE_OPERATION") not in ("plan-fixture-repair", "resume-fixture-upload")
            or not re.fullmatch("[a-f0-9]{64}", env.get("NATIVE_FIXTURE_SIGNER_SHA256", ""))
            or not re.fullmatch("[a-f0-9]{40}", revision) or parents != [revision, REVISION]):
        raise ValueError("The interrupted upload requires its immediate protected repair revision")


def source_documents(get=actions_get):
    run, data = protected_archive(REVISION, ARTIFACT, ARCHIVE_DIGEST, prefix="native-storage-release-",
                                  conclusions={"failure"}, get=get)
    if run != RUN:
        raise ValueError("Unexpected source run for the interrupted upload")
    inventory = json.loads(get(f"runs/{RUN}/attempts/1/jobs?per_page=100"))
    if len(inventory["jobs"]) != inventory["total_count"]:
        raise ValueError("Incomplete interrupted-upload job inventory")
    release, = [job for job in inventory["jobs"] if job["name"] == "release"]
    observed = [(step["name"], step["conclusion"]) for step in release["steps"] if step["name"] in STEPS]
    if release["conclusion"] != "failure" or observed != list(STEPS.items()):
        raise ValueError("Release did not stop after upload and before promotion")
    with ZipFile(BytesIO(data)) as archive:
        if sorted(archive.namelist()) != ["native-release.json", "native-release.json.controls"]:
            raise ValueError("Unexpected interrupted-upload evidence")
        snapshot = json.loads(archive.read("native-release.json"))
        controls = json.loads(archive.read("native-release.json.controls"))
    if snapshot["revision"] != REVISION or controls != {"digest": CONTROLS_DIGEST}:
        raise ValueError("Original release or retained financial controls differ")
    return snapshot, controls


def main():
    parents = subprocess.check_output(["git", "rev-list", "--parents", "-n", "1", "HEAD"], text=True).split()
    verify_dispatch(os.environ, parents)
    snapshot, controls = source_documents()
    directory = Path(os.environ["RUNNER_TEMP"])
    for filename, value in [("native-release.json.source", snapshot), ("native-release.json.source.controls", controls)]:
        with os.fdopen(os.open(directory / filename, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600), "w") as file:
            json.dump(value, file)


if __name__ == "__main__":
    main()
