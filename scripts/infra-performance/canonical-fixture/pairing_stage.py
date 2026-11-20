"""Authenticate a sealed replacement, its original controls and the source used by its Workers."""
from io import BytesIO
import json
import os
from pathlib import Path
import re
import sys
from uuid import UUID
from zipfile import ZipFile

from qualified_release import ROLLOUT_STEPS, actions_get, protected_archive, retained_provider
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


RESUME = "Resume the exact uploaded Workers at zero traffic"
RESTORE_UPLOAD = "Authenticate the interrupted pairing upload and its original controls"
INTERRUPTED_STEPS = {**STEPS, STAGE: "failure",
    "Persist and read back private observability on the installed application Workers": "skipped",
    QUALIFY_ORIGINAL: "skipped", "Seal dormant fallback stage before promotion": "skipped"}
RESUME_STEPS = {}
for name, result in STEPS.items():
    RESUME_STEPS[name] = ("skipped" if name in (UPLOAD, STAGE, "Capture the native stable pair",
                          "Authenticate the predecessor of the pairing repair") else result)
    if name == "Bind the protected verifier to the staged application source":
        RESUME_STEPS[RESTORE_UPLOAD] = "success"
    if name == STAGE:
        RESUME_STEPS[RESUME] = "success"


FAILED_RESUME_STEPS = {**RESUME_STEPS, QUALIFY_ORIGINAL: "failure", "Seal dormant fallback stage before promotion": "skipped"}


PARTIAL_ROLLBACK = {
    "revision": "0ba692ff68c1d63da1f4a7fdb8d6df5ff1566287",
    "run": "44758572606",
    "artifact": "14640046634",
    "sha256": "d8b73a2b1409448d339430082519eea1285ccdec194fec9e4344fb833554fdfa",
    "ingressDeploymentId": "d51a58f1-d274-4471-b887-802ee570ddc9",
}
PARTIAL_ROLLBACK_STEPS = {}
for name, result in ROLLOUT_STEPS.items():
    if name == "Verify the installed application and retained schema markers":
        PARTIAL_ROLLBACK_STEPS[name] = "failure"
        PARTIAL_ROLLBACK_STEPS["Restore only a compatible, tested target after failed promoted verification"] = "failure"
    else:
        PARTIAL_ROLLBACK_STEPS[name] = result

RESTORED_ROLLBACK = {
    "verifier": "29c6eb9dcd30fb8a3c561b6e72557926ce96063b",
    "run": "44763227392",
    "artifact": "14641568237",
    "sha256": "0362e572af7a13b6d02cd7735f7742668c8bf9ea6213f3a98f4740e5ee448a41",
    "coreDeploymentId": "5e7ec6e7-47c9-49d2-b740-1713ee3919da",
}
RESTORED_ROLLBACK_STEPS = {
    "Require closed admission in the protected environment": "success",
    "Bind the protected verifier to the staged application source": "success",
    "Check the reviewed release policy": "success",
    UPLOAD: "skipped",
    STAGE: "skipped",
    "Finish only the tested closed forward repair": "skipped",
    "Verify mixed and candidate versions before promoting closed admission": "skipped",
    "Verify the installed application and retained schema markers": "skipped",
    "Restore only a compatible, tested target after failed promoted verification": "skipped",
    "Restore only the remaining Core from the archived rollback": "success",
    "Exercise the tested code-only rollback": "skipped",
    "Retain native release evidence": "success",
}


def rollback_documents(stage, prior, seal, get=actions_get):
    pin = PARTIAL_ROLLBACK
    if stage["revision"] != pin["revision"]:
        raise ValueError("Rollback requires the exact application from the interrupted rollout")
    run, data = protected_archive(pin["revision"], pin["artifact"], pin["sha256"],
                                  prefix="native-storage-release-", conclusions={"failure"}, get=get)
    if run != pin["run"]:
        raise ValueError("Unexpected interrupted rollback source run")
    require_steps(get, run, "failure", PARTIAL_ROLLBACK_STEPS)
    with ZipFile(BytesIO(data)) as archive:
        names = {"native-release.json" + suffix for suffix in ("", ".controls", ".predecessor", ".promoted", ".seal")}
        members = archive.infolist()
        if (len(members) != len(names) or {item.filename for item in members} != names
                or any(not 0 < item.file_size <= 65_536 for item in members)):
            raise ValueError("Unexpected interrupted rollback archive")
        documents = {item.filename: json.loads(archive.read(item)) for item in members}
    receipt = documents["native-release.json.promoted"]
    release = receipt["release"]
    snapshot = release["snapshot"]
    if (receipt["rollbackTested"] is not True or release != documents["native-release.json"]
            or documents["native-release.json.seal"] != seal
            or documents["native-release.json.predecessor"] != prior
            or documents["native-release.json.controls"] != {"digest": stage["controlsDigest"]}
            or snapshot["revision"] != stage["revision"] or snapshot["stableRevision"] != stage["revision"]
            or any(snapshot[role]["stableVersionId"] != stage["release"][role + "VersionId"]
                   or snapshot[role]["name"] != stage["release"]["snapshot"][role]["name"]
                   for role in ("core", "public"))):
        raise ValueError("Interrupted rollout differs from its independently sealed compatible return pair")
    return {
        "native-release.json.promoted": receipt,
        "native-release.json.controls": documents["native-release.json.controls"],
        "native-release.json.rollback-position": {"ingressDeploymentId": pin["ingressDeploymentId"]},
    }


def requires_restored_source(application, verifier, git=git_read):
    restored = RESTORED_ROLLBACK["verifier"]
    return (application == PARTIAL_ROLLBACK["revision"]
            and git("merge-base", restored, verifier) == restored)


def restored_source(verifier, stage, prior, seal, get=actions_get, git=git_read):
    pin = RESTORED_ROLLBACK
    verify_tree(verifier, git, pin["verifier"])
    documents = rollback_documents(stage, prior, seal, get)
    run, data = protected_archive(pin["verifier"], pin["artifact"], pin["sha256"],
                                  prefix="native-storage-release-", conclusions={"success"}, get=get)
    if run != pin["run"]:
        raise ValueError("Unexpected protected restoration run")
    require_steps(get, run, "success", RESTORED_ROLLBACK_STEPS)
    positions = {"coreDeploymentId":pin["coreDeploymentId"],
                 "publicDeploymentId":PARTIAL_ROLLBACK["ingressDeploymentId"]}
    versions = {"revision":stage["revision"], "admission":"closed", **{
        role + "VersionId":stage["release"][role + "VersionId"] for role in ("core", "public")}}
    check_documents(data, {**documents, "native-release.json.predecessor":prior,
                           "native-release.json.seal":seal, "native-release.json.restored":versions,
                           "native-release.json.restored-deployments":positions})
    return {"artifactId":pin["artifact"], "sha256":pin["sha256"],
            "receipt":documents["native-release.json.promoted"], "restored":positions}


def upload_pin():
    return json.loads((Path(__file__).resolve().parents[3] / "infra/cloudflare/native-pairing-upload.json").read_bytes())


def original_snapshot(application, prior):
    snapshot = {**prior["snapshot"], "revision": application}
    for role in ("core", "public"):
        snapshot[role] = {**snapshot[role], "deploymentId": prior[role + "DeploymentId"]}
    return snapshot


def upload_documents(prior, controls, get=actions_get):
    pin = upload_pin()
    run, data = protected_archive(pin["revision"], pin["artifact"], pin["sha256"], prefix="native-storage-release-",
                                  conclusions={"failure"}, get=get)
    if run != pin["run"]:
        raise ValueError("Interrupted pairing upload run differs")
    require_steps(get, run, "failure", INTERRUPTED_STEPS)
    documents = {"native-release.json":original_snapshot(pin["revision"], prior), "native-release.json.controls":controls,
                 "native-release.json.predecessor":prior, "native-release.json.source.controls":controls}
    check_documents(data, documents)
    return documents


def check_documents(data, documents):
    with ZipFile(BytesIO(data)) as archive:
        if (sorted(archive.namelist()) != sorted(documents)
                or any(not 0 < item.file_size <= 65_536 or json.loads(archive.read(item)) != documents[item.filename]
                       for item in archive.infolist())):
            raise ValueError("Archived assignments, controls or stage outcome differ")


def replacement_documents(get=actions_get, git=git_read):
    pin = upload_pin()
    failed = pin["failedStage"]
    verify_tree(failed["verifier"], git, pin["revision"])
    prior, controls = staged_documents(get)
    uploaded = upload_documents(prior, controls, get)
    run, data = protected_archive(failed["verifier"], failed["artifact"], failed["sha256"],
                                  prefix="native-storage-release-", conclusions={"failure"}, get=get)
    if run != failed["run"]:
        raise ValueError("Unexpected failed qualification of the staged repair")
    require_steps(get, run, "failure", FAILED_RESUME_STEPS)
    staged = {"snapshot": uploaded["native-release.json"], "coreVersionId": pin["coreVersionId"],
              "publicVersionId": pin["publicVersionId"], "coreDeploymentId": failed["coreDeploymentId"],
              "publicDeploymentId": failed["publicDeploymentId"]}
    check_documents(data, {**uploaded, "native-release.json": staged})
    return staged, controls


def restore_upload(env):
    application = upload_pin()["revision"]
    verify_dispatch(env, application=application)
    if env["FIXTURE_RELEASE_OPERATION"] != "resume-pairing-stage" or env["RELEASE_GIT_SHA"] != env["GITHUB_SHA"]:
        raise ValueError("The interrupted upload requires its protected resume operation")
    documents = upload_documents(*staged_documents())
    for name, value in documents.items():
        with os.fdopen(os.open(Path(env["RUNNER_TEMP"]) / name, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600), "w") as file:
            json.dump(value, file)
    with open(env["GITHUB_ENV"], "a") as handle:
        handle.write(f"RELEASE_GIT_SHA={application}\nFIXTURE_STAGED_VERIFIER_SHA={env['GITHUB_SHA']}\n")


def sealed_pair(verifier, artifact_id, digest, get=actions_get, git=git_read):
    if not re.fullmatch("[1-9][0-9]{0,19}", artifact_id or ""):
        raise ValueError("Missing protected replacement artifact")
    issuer = json.loads(get("artifacts/" + artifact_id))["workflow_run"]["head_sha"]
    if (not re.fullmatch("[a-f0-9]{40}", issuer)
            or git("merge-base", PAIRING_REPAIR, issuer) != PAIRING_REPAIR):
        raise ValueError("Unexpected replacement source lineage")
    run, data = protected_archive(issuer, artifact_id, digest, prefix="native-fixture-fallback-",
                                  conclusions={"success"}, get=get)
    verify_tree(verifier, git, issuer)
    with ZipFile(BytesIO(data)) as archive:
        member, = archive.infolist()
        if member.filename != "native-fallback-stage.json" or not 0 < member.file_size <= 65_536:
            raise ValueError("Unexpected replacement seal archive")
        stage = json.loads(archive.read(member))
    if "fixtureMember" in stage:
        raise ValueError("Historical pairing repair cannot authorize another fixture member")
    release = stage["release"]
    application = stage["revision"]
    if application == issuer:
        require_steps(get, run, "success", STEPS)
        failed = upload_pin()["failedStage"]
        if git("merge-base", failed["verifier"], issuer) == failed["verifier"]:
            prior, controls = replacement_documents(get, git)
        else:
            prior, controls = staged_documents(get)
    else:
        pin = upload_pin()
        if (application != pin["revision"] or stage["smoke"] != pin["smoke"]
                or any(release[k] != pin[k] for k in ("coreVersionId", "publicVersionId"))):
            raise ValueError("Resumed seal differs from the exact uploaded Workers")
        verify_tree(issuer, git, application)
        require_steps(get, run, "success", RESUME_STEPS)
        prior, controls = staged_documents(get)
        upload_documents(prior, controls, get)
    snapshot = original_snapshot(application, prior)
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
    operation = env["FIXTURE_RELEASE_OPERATION"]
    if (operation not in ("recover-fixture-fallback", "resume-pairing-rollback", "rollout", "verify")
            or env.get("EXPECTED_INSTALLED_REVISION") != application):
        raise ValueError("Unexpected operation or requested installed revision")
    # Keep the seal's independently approved coordinates in the active release archive.
    seal = {"artifactId":artifact_id, "sha256":digest}
    documents = {"native-fallback-stage.json": stage, "native-release.json.predecessor": prior,
                 "native-release.json.seal": seal}
    if operation == "resume-pairing-rollback":
        documents.update(rollback_documents(stage, prior, seal))
    if operation == "rollout" and requires_restored_source(application, verifier):
        documents["native-release.json.restored-source"] = restored_source(verifier, stage, prior, seal)
    for name, value in documents.items():
        with os.fdopen(os.open(Path(env["RUNNER_TEMP"]) / name, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600), "w") as file:
            json.dump(value, file)
    with open(env["GITHUB_ENV"], "a") as handle:
        handle.write(f"RELEASE_GIT_SHA={application}\nFIXTURE_PAIRING_APPLICATION={application}\nFIXTURE_STAGED_VERIFIER_SHA={verifier}\n")
        if "native-release.json.restored-source" in documents:
            handle.write("FIXTURE_RESTORED_ROLLBACK=true\n")


if __name__ == "__main__":
    if sys.argv[1:] == ["resume-upload"]:
        restore_upload(os.environ)
    elif not sys.argv[1:]:
        bind(os.environ)
    else:
        raise ValueError("Unknown pairing stage operation")
