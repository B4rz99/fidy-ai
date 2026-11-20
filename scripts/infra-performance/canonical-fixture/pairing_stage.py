"""Authenticate a sealed replacement, its original controls and the source used by its Workers."""
from io import BytesIO
import json
import os
from pathlib import Path
import re
from uuid import UUID
from zipfile import ZipFile

from qualified_release import actions_get, protected_archive, retained_provider
from staged_application import git_read, require_steps, verify_tree
from unsealed_stage import PAIRING_REPAIR, STAGE, UPLOAD, QUALIFY, QUALIFY_ORIGINAL, staged_documents, verify_dispatch

OWNERS = ("user", "directory", "pricing", "maintenance", "erasure")
# Stage qualification ends at publication of the dormant seal. Forward recovery is a separate dispatch.
STEPS = {
    "Require closed admission in the protected environment": "success",
    "Bind the protected verifier to the staged application source": "skipped",
    "Install the verified fresh native application": "skipped",
    "Authenticate the original interrupted upload before planning or applying its repair": "skipped",
    "Authenticate the unsealed zero-traffic pair": "skipped",
    "Authenticate the predecessor of the pairing repair": "success",
    "Capture the native stable pair": "success",
    UPLOAD: "success",
    STAGE: "success",
    "Persist and read back private observability on the installed application Workers": "success",
    QUALIFY_ORIGINAL: "success",
    QUALIFY: "skipped",
    "Compare pairing requests on the archived zero-traffic pair": "skipped",
    "Seal dormant fallback stage before promotion": "success",
    "Authenticate the interrupted dormant stage": "skipped",
    "Finish only the tested closed forward repair": "skipped",
    "Verify mixed and candidate versions before promoting closed admission": "skipped",
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


def sealed_pair(verifier, artifact_id, digest, get=actions_get, git=git_read):
    if not re.fullmatch("[1-9][0-9]{0,19}", artifact_id or ""):
        raise ValueError("Missing protected replacement artifact")
    application = json.loads(get("artifacts/" + artifact_id))["workflow_run"]["head_sha"]
    if (not re.fullmatch("[a-f0-9]{40}", application)
            or git("merge-base", PAIRING_REPAIR, application) != PAIRING_REPAIR):
        raise ValueError("Unexpected replacement source lineage")
    run, data = protected_archive(application, artifact_id, digest, prefix="native-fixture-fallback-",
                                  conclusions={"success"}, get=get)
    require_steps(get, run, "success", STEPS)
    verify_tree(verifier, git, application)
    with ZipFile(BytesIO(data)) as archive:
        member, = archive.infolist()
        if member.filename != "native-fallback-stage.json" or not 0 < member.file_size <= 65_536:
            raise ValueError("Unexpected replacement seal archive")
        stage = json.loads(archive.read(member))
    prior, controls = staged_documents(get)
    snapshot = {**prior["snapshot"], "revision": application}
    for role in ("core", "public"):
        snapshot[role] = {**snapshot[role], "deploymentId": prior[role + "DeploymentId"]}
    release = stage["release"]
    ids = [release[role + kind] for role in ("public", "core") for kind in ("VersionId", "DeploymentId")]
    original = {prior[role + kind] for role in ("public", "core") for kind in ("VersionId", "DeploymentId")}
    original.update(snapshot[role]["stableVersionId"] for role in ("public", "core"))
    namespaces = stage["namespaces"]
    if (stage["revision"] != application or stage["stableRevision"] != snapshot["stableRevision"]
            or release["snapshot"] != snapshot or stage["controlsDigest"] != controls["digest"]
            or stage["provider"] != retained_provider() or len(set(ids)) != len(ids) or original.intersection(ids)
            or any(str(UUID(value)) != value for value in ids + [stage["smoke"][k] for k in ("versionId", "deploymentId")])
            or set(namespaces) != set(OWNERS) or len(set(namespaces.values())) != len(OWNERS)
            or not all(re.fullmatch("[a-f0-9]{32}", value) for value in namespaces.values())):
        raise ValueError("Replacement stage differs from its protected source, namespace inventory or retained financial controls")
    return stage, prior


def bind(env):
    verifier = env["GITHUB_SHA"]
    artifact_id, digest = env["STAGE_ARTIFACT"], env["STAGE_SHA256"]
    stage, prior = sealed_pair(verifier, artifact_id, digest)
    application = stage["revision"]
    verify_dispatch(env, application=application)
    if (env["FIXTURE_RELEASE_OPERATION"] not in ("recover-fixture-fallback", "rollout", "verify")
            or env.get("EXPECTED_INSTALLED_REVISION") != application):
        raise ValueError("Unexpected operation or requested installed revision")
    # Keep the seal's independently approved coordinates in the active release archive.
    for name, value in [("native-fallback-stage.json", stage), ("native-release.json.predecessor", prior),
                        ("native-release.json.seal", {"artifactId":artifact_id, "sha256":digest})]:
        with os.fdopen(os.open(Path(env["RUNNER_TEMP"]) / name, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600), "w") as file:
            json.dump(value, file)
    with open(env["GITHUB_ENV"], "a") as handle:
        handle.write(f"RELEASE_GIT_SHA={application}\nFIXTURE_PAIRING_APPLICATION={application}\nFIXTURE_STAGED_VERIFIER_SHA={verifier}\n")


if __name__ == "__main__":
    bind(os.environ)
