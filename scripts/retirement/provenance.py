"""Authenticate protected workflow artifacts before a retirement decision."""
from hashlib import sha256
from io import BytesIO
import json
import os
import re
import subprocess
from zipfile import ZipFile

from provider import Refused, require

REPOSITORY = "B4rz99/fidy-ai"
RETIREMENT_WORKFLOW = ".github/workflows/native-incumbent-retirement.yml"
ID = re.compile(r"[1-9][0-9]{0,19}")
SHA = re.compile(r"[a-f0-9]{64}")
REVISION = re.compile(r"[a-f0-9]{40}")
MAX_ARTIFACT = 768_000


def protected_runner():
    expected = {
        "GITHUB_ACTIONS": "true", "GITHUB_REF_PROTECTED": "true", "GITHUB_REF": "refs/heads/trunk",
        "GITHUB_REPOSITORY": REPOSITORY, "GITHUB_EVENT_NAME": "workflow_dispatch",
        "GITHUB_WORKFLOW_REF": REPOSITORY + "/" + RETIREMENT_WORKFLOW + "@refs/heads/trunk",
    }
    require(all(os.environ.get(key) == value for key, value in expected.items()),
            "Retirement requires the protected production workflow")
    revision = os.environ.get("GITHUB_SHA", "")
    require(REVISION.fullmatch(revision) and
            subprocess.check_output(["git", "rev-parse", "HEAD"], text=True, timeout=10).strip() == revision,
            "Retirement checkout does not match the protected revision")


def gh(path):
    try:
        return subprocess.check_output(["gh", "api", f"repos/{REPOSITORY}/actions/" + path], timeout=40)
    except (subprocess.SubprocessError, OSError):
        raise Refused("Protected GitHub artifact read failed") from None


def authenticated_archive(artifact, expected_sha, workflow, filename, archive_name):
    require(ID.fullmatch(artifact) and SHA.fullmatch(expected_sha), "Invalid protected artifact coordinates")
    source = json.loads(gh("artifacts/" + artifact))
    run = source["workflow_run"]
    revision = run.get("head_sha", "")
    require(str(source["id"]) == artifact and source["expired"] is False and
            source["digest"] == "sha256:" + expected_sha and source["size_in_bytes"] <= MAX_ARTIFACT and
            ID.fullmatch(str(run["id"])) and REVISION.fullmatch(revision), "Protected artifact identity differs")
    history = json.loads(gh("runs/" + str(run["id"])))
    require(history["path"] == workflow and history["head_branch"] == "trunk" and
            history["event"] == "workflow_dispatch" and history["status"] == "completed" and
            history["conclusion"] == "success" and history["head_sha"] == revision and
            source["name"] == archive_name + str(run["id"]),
            "Artifact did not come from the required protected workflow")
    ancestor = subprocess.run(["git", "merge-base", "--is-ancestor", revision, os.environ["GITHUB_SHA"]],
                              check=False, timeout=15)
    require(ancestor.returncode == 0, "Protected artifact commit is outside the checked-out ancestry")
    encoded = gh("artifacts/" + artifact + "/zip")
    require(len(encoded) <= MAX_ARTIFACT and sha256(encoded).hexdigest() == expected_sha,
            "Protected retirement archive digest differs")
    with ZipFile(BytesIO(encoded)) as archive:
        require(archive.namelist() == [filename] and archive.getinfo(filename).file_size <= MAX_ARTIFACT,
                "Protected artifact has unexpected members")
        result = json.loads(archive.read(filename))
    require(type(result) is dict, "Protected artifact must contain a structured receipt")
    return result, revision
