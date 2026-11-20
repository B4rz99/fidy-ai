"""Recover the sealed pre-promotion checkpoint from the original protected bootstrap run."""
import argparse
from io import BytesIO
import json
import os
from pathlib import Path
import re
from zipfile import ZipFile

from qualified_release import REPO, actions_get, protected_archive


def load_stage(revision, artifact_id, archive_sha256, get=actions_get):
    run_id, data = protected_archive(
        revision, artifact_id, archive_sha256, prefix="native-fixture-fallback-",
        conclusions={"success", "failure", "cancelled", "timed_out"}, get=get)
    jobs = json.loads(get(f"runs/{run_id}/attempts/1/jobs?per_page=100"))
    if len(jobs["jobs"]) != jobs["total_count"]:
        raise ValueError("Incomplete fallback workflow job inventory")
    release, = [job for job in jobs["jobs"] if job["name"] == "release"]
    seal, = [step for step in release["steps"] if step["name"] == "Seal dormant fallback stage before promotion"]
    if seal["conclusion"] != "success":
        raise ValueError("Source did not seal the dormant pair before promotion")
    with ZipFile(BytesIO(data)) as archive:
        member, = archive.infolist()
        if member.filename != "native-fallback-stage.json" or not 0 < member.file_size <= 65_536:
            raise ValueError("Unexpected fallback stage archive")
        stage = json.loads(archive.read(member))
    if stage["revision"] != revision:
        raise ValueError("Archived fallback stage does not match this revision")
    return stage


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--artifact-id", required=True)
    parser.add_argument("--sha256", required=True)
    parser.add_argument("--out", required=True, type=Path)
    args = parser.parse_args()
    revision = os.environ["GITHUB_SHA"]
    if (os.environ.get("GITHUB_REPOSITORY") != REPO or os.environ.get("GITHUB_REF") != "refs/heads/trunk"
            or os.environ.get("GITHUB_REF_PROTECTED") != "true" or os.environ.get("GITHUB_EVENT_NAME") != "workflow_dispatch"
            or os.environ.get("NATIVE_STORAGE_ADMISSION") != "closed" or not re.fullmatch("[a-f0-9]{40}", revision)):
        raise ValueError("Closed protected trunk required for fallback recovery")
    stage = load_stage(revision, args.artifact_id, args.sha256)
    destination = Path(os.environ["RUNNER_TEMP"]) / "native-fallback-stage.json"
    if args.out != destination:
        raise ValueError("Use the designated runner-local fallback checkpoint")
    with os.fdopen(os.open(destination, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), "w") as file:
        json.dump(stage, file)


if __name__ == "__main__":
    main()
