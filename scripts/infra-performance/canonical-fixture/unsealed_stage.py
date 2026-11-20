"""Authenticate a previously staged zero-traffic pair for independent qualification on a protected verifier."""
import argparse
from io import BytesIO
import json
import os
from pathlib import Path
from zipfile import ZipFile

from interrupted_upload import source_documents
from staged_application import APPLICATION, STAGED_IDS, git_read, require_steps, verify_tree
from qualified_release import REPO, actions_get, archive_verifier, protected_archive, fixture_upload

RUN = "44685945098"
ARTIFACT = "14606856220"
ARCHIVE_DIGEST = "75b009f7e7d7d12b156d9a8bf690e33ed3027a381e05f3d1e7a1e7f7ce622927"
QUALIFY = "Requalify the archived zero-traffic pair without moving traffic"
SEAL = "Seal dormant fallback stage before promotion"
FORWARD = "Finish only the tested closed forward repair"
UPLOAD = "Upload the verified native candidates"
STAGE = "Stage the zero-traffic native candidates"
NORMAL_PROMOTION = "Verify mixed and candidate versions before promoting closed admission"
AUTHENTICATE = "Authenticate the unsealed zero-traffic pair"
QUALIFY_ORIGINAL = "Qualify the closed recovery artifacts and their retained controls"
STAGING_STEPS = {
    "Require closed admission in the protected environment": "success",
    "Authenticate the original interrupted upload before planning or applying its repair": "success",
    UPLOAD: "success", STAGE: "success",
    "Persist and read back private observability on the installed application Workers": "success",
    QUALIFY_ORIGINAL: "failure", SEAL: "skipped", FORWARD: "skipped", NORMAL_PROMOTION: "skipped",
    "Retain native release evidence": "success",
}
RESEAL_STEPS = {
    "Require closed admission in the protected environment": "success",
    "Bind the protected verifier to the staged application source": "success",
    "Install the verified fresh native application": "skipped",
    AUTHENTICATE: "success", "Capture the native stable pair": "skipped", UPLOAD: "skipped", STAGE: "skipped",
    "Persist and read back private observability on the installed application Workers": "skipped",
    QUALIFY_ORIGINAL: "skipped", QUALIFY: "success", SEAL: "success", FORWARD: "skipped",
    NORMAL_PROMOTION: "skipped",
    "Stage only canonical Access paths and vacant hostnames on the verified closed release": "skipped",
    "Verify the installed application and retained schema markers": "skipped",
    "Verify the installed application and physical erasure of one disposable User": "skipped",
    "Continue physical verification of the previously admitted User": "skipped",
    "Measure one disposable User on the verified closed release": "skipped",
    "Complete cleanup of the archived single fleet User on the verified release": "skipped",
    "Restore only a compatible, tested target after failed promoted verification": "skipped",
    "Exercise the tested code-only rollback": "skipped",
    "Prepare the ten-User fleet admission": "skipped",
    "Measure ten hosted fleet Users": "skipped",
    "Complete the original ten-User cleanup": "skipped",
    "Retain native release evidence": "success",
}


def verify_dispatch(env, git=git_read):
    verifier = env.get("GITHUB_SHA", "")
    operation = env.get("FIXTURE_RELEASE_OPERATION")
    builds = {"diagnose-fixture-pairing":"fallback", "reseal-fixture-fallback":"fallback", "recover-fixture-fallback":"fallback",
              "rollout":"ordinary", "verify":"ordinary"}
    if (env.get("GITHUB_ACTIONS") != "true" or env.get("GITHUB_REPOSITORY") != REPO
            or env.get("GITHUB_WORKFLOW_REF") != f"{REPO}/.github/workflows/native-storage-release.yml@refs/heads/trunk"
            or env.get("GITHUB_REF") != "refs/heads/trunk"
            or env.get("GITHUB_REF_PROTECTED") != "true" or env.get("GITHUB_EVENT_NAME") != "workflow_dispatch"
            or env.get("GITHUB_RUN_ATTEMPT") != "1" or env.get("NATIVE_STORAGE_ADMISSION") != "closed"
            or env.get("NATIVE_STORAGE_HOSTS") != "acceptance" or operation not in builds
            or env.get("NATIVE_FIXTURE_BUILD") != builds[operation] or git("rev-parse", "HEAD") != verifier
            or env.get("NATIVE_FIXTURE_SIGNER_SHA256") != fixture_upload()["fingerprint"]):
        raise ValueError("A first-attempt protected verifier and the closed signed installation are required")
    verify_tree(verifier, git)


def staged_documents(get=actions_get):
    run, data = protected_archive(APPLICATION, ARTIFACT, ARCHIVE_DIGEST, prefix="native-storage-release-",
                                  conclusions={"failure"}, get=get)
    if run != RUN:
        raise ValueError("Unexpected source run for the staged candidates")
    require_steps(get, run, "failure", STAGING_STEPS)
    original, controls = source_documents(get)
    expected = {"snapshot": {**original, "revision": APPLICATION}, **STAGED_IDS}
    documents = {"native-release.json": expected, "native-release.json.controls": controls,
                 "native-release.json.source": original, "native-release.json.source.controls": controls}
    with ZipFile(BytesIO(data)) as archive:
        if (sorted(archive.namelist()) != sorted(documents)
                or any(json.loads(archive.read(name)) != value for name, value in documents.items())):
            raise ValueError("Staged archive differs from the original independently authenticated controls or pair")
    return expected, controls


def resealed_document(verifier, artifact_id, digest, get=actions_get, git=git_read):
    source = archive_verifier(artifact_id, verifier, get, git)
    run, data = protected_archive(source, artifact_id, digest, prefix="native-fixture-fallback-",
                                  conclusions={"success"}, get=get)
    require_steps(get, run, "success", RESEAL_STEPS)
    staged, controls = staged_documents(get)
    with ZipFile(BytesIO(data)) as archive:
        member, = archive.infolist()
        if member.filename != "native-fallback-stage.json" or not 0 < member.file_size <= 65_536:
            raise ValueError("Unexpected resealed stage archive")
        stage = json.loads(archive.read(member))
    if (stage["revision"] != APPLICATION or stage["stableRevision"] != staged["snapshot"]["stableRevision"]
            or stage["release"] != staged or stage["controlsDigest"] != controls["digest"]):
        raise ValueError("Resealed stage differs from the authorized pair or original financial controls")
    return stage


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=("source", "restore", "replacement"))
    args = parser.parse_args()
    if args.action == "replacement":
        env = os.environ
        if (env.get("FIXTURE_RELEASE_OPERATION") not in ("plan-pairing-repair", "stage-pairing-repair")
                or env.get("GITHUB_REPOSITORY") != REPO or env.get("GITHUB_ACTIONS") != "true"
                or env.get("GITHUB_WORKFLOW_REF") != f"{REPO}/.github/workflows/native-storage-release.yml@refs/heads/trunk"
                or env.get("GITHUB_REF_PROTECTED") != "true" or env.get("GITHUB_REF") != "refs/heads/trunk"
                or env.get("GITHUB_EVENT_NAME") != "workflow_dispatch" or env.get("GITHUB_RUN_ATTEMPT") != "1"
                or env.get("NATIVE_STORAGE_ADMISSION") != "closed" or env.get("NATIVE_STORAGE_HOSTS") != "acceptance"
                or env.get("NATIVE_FIXTURE_BUILD") != "fallback"
                or env.get("NATIVE_FIXTURE_SIGNER_SHA256") != fixture_upload()["fingerprint"]
                or env.get("GITHUB_SHA") != git_read("rev-parse", "HEAD")
                or env.get("RELEASE_GIT_SHA") != env["GITHUB_SHA"]
                or git_read("merge-base", APPLICATION, env["GITHUB_SHA"]) != APPLICATION):
            raise ValueError("Replacement requires the new protected application source and closed acceptance hosts")
        staged, controls = staged_documents()
        for name, value in [("native-release.json.predecessor", staged), ("native-release.json.source.controls", controls)]:
            with os.fdopen(os.open(Path(env["RUNNER_TEMP"]) / name, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600), "w") as file:
                json.dump(value, file)
        return
    verify_dispatch(os.environ)
    if args.action == "source":
        staged_documents()
        with open(os.environ["GITHUB_ENV"], "a") as env:
            env.write(f"RELEASE_GIT_SHA={APPLICATION}\n")
            env.write(f"FIXTURE_STAGED_VERIFIER_SHA={os.environ['GITHUB_SHA']}\n")
        return
    if os.environ["FIXTURE_RELEASE_OPERATION"] not in {"reseal-fixture-fallback", "diagnose-fixture-pairing"}:
        raise ValueError("Only the separate diagnostic and qualification operations may restore the unsealed stage")
    staged, controls = staged_documents()
    for name, value in [("native-release.json", staged), ("native-release.json.controls", controls)]:
        with os.fdopen(os.open(Path(os.environ["RUNNER_TEMP"]) / name, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600), "w") as file:
            json.dump(value, file)


if __name__ == "__main__":
    main()
