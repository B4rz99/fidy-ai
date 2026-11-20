"""Authenticate the same-revision protected successor stage and promotion archive."""
from io import BytesIO
import json
import os
from pathlib import Path
import re
from uuid import UUID
from zipfile import ZipFile

from qualified_release import actions_get, fixture_upload, protected_archive, retained_provider
from successor_source import ACTIVE_ARTIFACT, ORIGINAL_CLEANUP, ORIGINAL_REVISION, WORKFLOW_REF, approved_plan

WORKFLOW = "native-fixture-successor-plan.yml"
OWNERS = ("user", "directory", "pricing", "maintenance", "erasure")
STAGE_STEPS = {
    "Authenticate the original release, receipt, and exact erasure": "success",
    "Inspect the scoped successor resources": "skipped",
    "Upload the approved successor resources": "success",
    "Recheck the predecessor and disposal before assigning the successors": "success",
    "Stage the verified successors at zero traffic": "success",
    "Verify the successor and seal the dormant stage": "success",
    "Save the zero-traffic successor seal": "success",
    "Restore the sealed successor dormant pair": "skipped",
    "Verify and promote the active successor with its tested return pair": "skipped",
}
RECOVERY_STEPS = {
    "Upload the approved successor resources": "skipped",
    "Verify the successor and seal the dormant stage": "skipped",
    "Restore the sealed successor dormant pair": "success",
    "Save the verified dormant recovery": "success",
    "Verify and promote the active successor with its tested return pair": "skipped",
}
ACTIVE_STEPS = {
    "Upload the approved successor resources": "skipped",
    "Verify the successor and seal the dormant stage": "skipped",
    "Restore the sealed successor dormant pair": "skipped",
    "Capture the verified successor dormant rollback position": "success",
    "Upload the reviewed active successor pair": "success",
    "Stage the active successor pair at zero traffic": "success",
    "Verify and promote the active successor with its tested return pair": "success",
    "Verify the installed successor and retained controls": "success",
    "Restore the sealed dormant pair after failed verification": "skipped",
    "Save the active successor release": "success",
}


def artifacts(revision, reference, prefix, expected_steps, filenames, get=actions_get):
    run, body = protected_archive(revision, reference["artifactId"], reference["sha256"], prefix=prefix,
                                  conclusions={"success"}, get=get, workflow=WORKFLOW)
    inventory = json.loads(get(f"runs/{run}/attempts/1/jobs?per_page=100"))
    job, = inventory["jobs"]
    steps = [(step["name"], step["conclusion"]) for step in job["steps"] if step["name"] in expected_steps]
    if (inventory["total_count"] != 1 or job["name"] != "plan" or job["conclusion"] != "success"
            or steps != list(expected_steps.items())):
        raise ValueError("Protected successor operation or step outcomes differ")
    with ZipFile(BytesIO(body)) as archive:
        rows = archive.infolist()
        if (len(rows) != len(filenames) or {row.filename for row in rows} != set(filenames)
                or any(not 0 < row.file_size <= 128_000 for row in rows)):
            raise ValueError("Unexpected protected successor evidence")
        return {row.filename:json.loads(archive.read(row)) for row in rows}


def require_sealed_source(revision, stage, plan):
    source = stage["predecessor"]
    release = stage["release"]
    snapshot = release["snapshot"]
    if (stage["revision"] != revision or source["revision"] != revision
            or stage["stableRevision"] != ORIGINAL_REVISION or stage["fixtureMember"] != "performance-2"
            or stage["provider"] != retained_provider() or stage["controlsDigest"] != fixture_upload()["controlsDigest"]
            or source["previousRevision"] != ORIGINAL_REVISION or source["previousRelease"] != ACTIVE_ARTIFACT
            or source["previousCleanup"] != ORIGINAL_CLEANUP[2] or source["signerSha256"] != fixture_upload()["fingerprint"]
            or {key:value for key,value in plan.items() if key not in ("member", "applied", "resources")} != source
            or snapshot["revision"] != revision or snapshot["stableRevision"] != ORIGINAL_REVISION):
        raise ValueError("Successor seal differs from its exact approved predecessor")
    if set(stage["namespaces"]) != set(OWNERS) or [stage["namespaces"][role] for role in OWNERS] != source["namespaces"]:
        raise ValueError("Successor seal namespace identities differ")
    ids, previous = list(stage["smoke"].values()), [source["oldSmokeVersionId"], source["oldSmokeDeploymentId"]]
    if set(stage["smoke"]) != {"versionId", "deploymentId"}:
        raise ValueError("Successor technical smoke coordinates differ")
    for role, title, name in (("core","Core","core"), ("public","Ingress","ingress")):
        stable = snapshot[role]
        expected = {"name":"fidy-native-storage-"+name,
                    "stableVersionId":source[f"stable{title}Version"], "deploymentId":source[f"stable{title}Deployment"]}
        if stable != expected:
            raise ValueError("Successor seal began from another stable installation")
        ids.extend([release[role+"VersionId"], release[role+"DeploymentId"]])
        previous.extend([stable["stableVersionId"], stable["deploymentId"]])
    if len(set(ids)) != len(ids) or set(ids).intersection(previous) or any(str(UUID(value)) != value for value in ids):
        raise ValueError("Successor seal contains a reused or invalid Worker assignment")


def sealed_successor(revision, reference, get=actions_get):
    filename = "native-fixture-successor-stage.json"
    stage = artifacts(revision, reference, "native-fixture-successor-stage-", STAGE_STEPS, [filename], get)[filename]
    approval = stage["approval"]
    plan = approved_plan(revision, approval["artifactId"], approval["sha256"], get)
    require_sealed_source(revision, stage, plan)
    return stage


def recovered_successor(revision, reference, seal, get=actions_get):
    filename = "native-fixture-successor-recovered.json"
    data = artifacts(revision, reference, "native-fixture-successor-recovered-", RECOVERY_STEPS, [filename], get)[filename]
    stage = sealed_successor(revision, seal, get)
    if data["seal"] != seal or data["stage"] != stage:
        raise ValueError("Dormant recovery depends on another successor seal")
    promoted = data["promoted"]
    ids = [promoted[role+"DeploymentId"] for role in ("core", "public")]
    previous = [stage["release"][role+"DeploymentId"] for role in ("core", "public")]
    if (len(set(ids)) != len(ids) or set(ids).intersection(previous)
            or any(str(UUID(value)) != value for value in ids)):
        raise ValueError("Dormant successor contains invalid deployment positions")
    return data


def active_successor(revision, reference, get=actions_get):
    promotion_name, installation_name = "native-release.json.promoted", "native-verification.json"
    seal_name, recovery_name = "fixture-successor-seal-reference.json", "fixture-successor-recovery-reference.json"
    files = artifacts(revision, reference, "native-fixture-successor-active-", ACTIVE_STEPS,
                      [promotion_name, installation_name, seal_name, recovery_name], get)
    recovered = recovered_successor(revision, files[recovery_name], files[seal_name], get)
    stage, promoted = recovered["stage"], recovered["promoted"]
    promotion, installed = files[promotion_name], files[installation_name]
    release = promotion["release"]
    snapshot = release["snapshot"]
    smoke, = [worker for worker in installed["workers"] if worker["role"] == "Smoke"]
    if (promotion["rollbackTested"] is not True or snapshot["revision"] != revision
            or snapshot["stableRevision"] != revision or installed["revision"] != revision
            or installed["verifierRevision"] != revision or installed["admission"] != "closed"
            or installed["fixtureMember"] != "performance-2" or installed["resourceRevision"] != revision
            or installed["retainedProvider"] != stage["provider"] or installed["fixtureControlsDigest"] != stage["controlsDigest"]
            or installed["namespaces"] != [stage["namespaces"][role] for role in OWNERS]
            or installed["userNamespace"] != stage["namespaces"]["user"]
            or any(smoke[key] != value for key,value in stage["smoke"].items())):
        raise ValueError("Active successor differs from the tested dormant installation")
    for role in ("core", "public"):
        version_key, deployment_key = role+"VersionId", role+"DeploymentId"
        if (snapshot[role]["deploymentId"] != promoted[deployment_key]
                or snapshot[role]["stableVersionId"] != stage["release"][version_key]
                or release[version_key] == stage["release"][version_key]):
            raise ValueError("Active successor does not identify its tested return pair")
    return promotion, installed


def main():
    env = os.environ
    operation = env.get("FIXTURE_RELEASE_OPERATION")
    revision = env.get("GITHUB_SHA", "")
    if (operation not in ("recover-fixture-successor", "rollout-fixture-successor")
            or not re.fullmatch(r"[a-f0-9]{40}", revision)
            or env.get("GITHUB_ACTIONS") != "true" or env.get("GITHUB_REF_PROTECTED") != "true"
            or env.get("GITHUB_REF") != "refs/heads/trunk" or env.get("GITHUB_EVENT_NAME") != "workflow_dispatch"
            or env.get("GITHUB_WORKFLOW_REF") != WORKFLOW_REF or env.get("GITHUB_RUN_ATTEMPT") != "1"
            or env.get("NATIVE_STORAGE_ADMISSION") != "closed" or env.get("NATIVE_STORAGE_HOSTS") != "acceptance"):
        raise ValueError("Requires the protected same-revision successor workflow")
    seal = {"artifactId":env["SUCCESSOR_SEAL_ARTIFACT"], "sha256":env["SUCCESSOR_SEAL_DIGEST"]}
    if operation == "recover-fixture-successor":
        stage = sealed_successor(revision, seal)
        files = {"native-fixture-successor-stage.json":stage}
    else:
        recovery = {"artifactId":env["SUCCESSOR_RECOVERY_ARTIFACT"], "sha256":env["SUCCESSOR_RECOVERY_DIGEST"]}
        recovered = recovered_successor(revision, recovery, seal)
        stage = recovered["stage"]
        files = {"native-fixture-successor-stage.json":stage, "native-fixture-successor-recovered.json":recovered,
                 "fixture-successor-recovery-reference.json":recovery}
    files.update({"fixture-successor-seal-reference.json":seal, "fixture-successor-source.json":stage["predecessor"]})
    for name, contents in files.items():
        with (Path(env["RUNNER_TEMP"]) / name).open("x") as file:
            json.dump(contents, file)


if __name__ == "__main__":
    main()
