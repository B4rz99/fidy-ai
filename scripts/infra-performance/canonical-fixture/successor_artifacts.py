"""Authenticate protected successor archives against their released source and verifier."""
from io import BytesIO
import json
import os
from pathlib import Path
import re
from uuid import UUID
from zipfile import ZipFile

from qualified_release import actions_get, fixture_upload, git_read, protected_archive, retained_provider
from successor_partial import (
    CORE_VERSION, INGRESS_VERSION, PLAN, PLAN_RUN, REVISION,
    SMOKE_DEPLOYMENT, SMOKE_VERSION, archived_partial, require_source,
)
from successor_source import ACTIVE_ARTIFACT, ORIGINAL_CLEANUP, ORIGINAL_REVISION, WORKFLOW_REF, approved_plan

WORKFLOW = "native-fixture-successor-plan.yml"
STAGED_ACCOUNTING_REVISION = "c85cb1574464a8d00223f80c48a83f55efd61958"
STAGED_ACCOUNTING_RUN = "44835921933"
STAGED_ACCOUNTING_ARTIFACT = {
    "artifactId": "14678486833",
    "sha256": "1a5e1990d9473bcb990f205e75b21da7c10a2c283e7fb08a1ca9928375bc405e",
}
STAGED_ACCOUNTING_COORDINATES = {
    "coreVersionId": "013feb2e-7912-4e84-9484-760248b6fb89",
    "coreDeploymentId": "d57c6525-d816-4d52-80fe-9064e63c50cc",
    "publicVersionId": "0c6ed781-9239-4359-98e9-7bff67f80c59",
    "publicDeploymentId": "9f91c7a5-b0fe-4c86-a507-dae8476f597e",
}
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
RESUME_CAPTURE_STEP = "Authenticate the repaired support and restore the exact captured predecessor"
RESEAL_CAPTURE_STEP = "Authenticate the failed stage and unchanged zero-traffic assignments"
RESEAL_SAVE_STEP = "Save the authenticated zero-traffic reseal"
SEAL_AUTH_STEP = "Authenticate same-SHA successor seals"
RESUMED_STAGE_STEPS = {
    "Require closed protected planning": "success",
    "Check the reviewed edge policy": "success",
    "Authenticate the original release, receipt, and exact erasure": "skipped",
    RESUME_CAPTURE_STEP: "success",
    SEAL_AUTH_STEP: "skipped",
    "Bind the protected plan to the reviewed revision": "success",
    "Inspect the scoped successor resources": "skipped",
    "Save the verified read-only successor inventory": "skipped",
    "Capture the exact predecessor and original financial controls": "skipped",
    "Upload the approved successor resources": "skipped",
    "Recheck the predecessor and disposal before assigning the successors": "skipped",
    "Stage the verified successors at zero traffic": "success",
    "Verify the successor and seal the dormant stage": "success",
    "Save the zero-traffic successor seal": "success",
    "Retain successor staging coordinates": "success",
    "Restore the sealed successor dormant pair": "skipped",
    "Save the verified dormant recovery": "skipped",
    "Rebuild the original retained Web assets for verification": "skipped",
    "Capture the verified successor dormant rollback position": "skipped",
    "Upload the reviewed active successor pair": "skipped",
    "Stage the active successor pair at zero traffic": "skipped",
    "Verify and promote the active successor with its tested return pair": "skipped",
    "Verify the installed successor and retained controls": "skipped",
    "Restore the sealed dormant pair after failed verification": "skipped",
    "Save the active successor release": "skipped",
    "Retain successor active rollout diagnostics": "skipped",
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


def archive_revision(revision, reference, verifier, get, git):
    if verifier is None:
        verifier = git("rev-parse", "HEAD") if revision == REVISION else revision
    if verifier == revision:
        return revision
    if revision != REVISION:
        if (not re.fullmatch(r"[a-f0-9]{40}", verifier)
                or git("merge-base", revision, verifier) != revision):
            raise ValueError("Successor archive is outside the protected verifier lineage")
        return revision
    artifact_id = reference["artifactId"]
    if (not re.fullmatch(r"[a-f0-9]{40}", verifier)
            or not re.fullmatch(r"[1-9][0-9]{0,19}", artifact_id or "")):
        raise ValueError("Unexpected resumed successor source or verifier")
    producer = json.loads(get("artifacts/" + artifact_id))["workflow_run"]["head_sha"]
    if (not re.fullmatch(r"[a-f0-9]{40}", producer or "")
            or git("merge-base", revision, producer) != revision
            or git("merge-base", producer, verifier) != producer):
        raise ValueError("Successor archive is outside the protected verifier lineage")
    return producer


def reseal_steps():
    steps = {}
    for name, outcome in RESUMED_STAGE_STEPS.items():
        steps[name] = "skipped" if name in (
            RESUME_CAPTURE_STEP, "Stage the verified successors at zero traffic",
            "Save the zero-traffic successor seal", "Retain successor staging coordinates",
        ) else outcome
        if name == RESUME_CAPTURE_STEP:
            steps[RESEAL_CAPTURE_STEP] = "success"
        if name == "Save the zero-traffic successor seal":
            steps[RESEAL_SAVE_STEP] = "success"
    return steps


def require_resumed_seal(stage, producer, plan, get, git, *, resealed=False):
    from successor_resume import workflow_receipt

    receipt = stage["resume"]
    fields = {
            "verifierRevision", "supportVerifierRevision", "supportArtifact", "supportSha256",
            "coreVersionId", "publicVersionId"}
    if resealed:
        fields.add("reseal")
    if not isinstance(receipt, dict) or set(receipt) != fields:
        raise ValueError("Unexpected resumed successor seal evidence")
    ids = {"coreVersionId": CORE_VERSION, "publicVersionId": INGRESS_VERSION}
    if (receipt["verifierRevision"] != producer
            or {name: receipt[name] for name in ids} != ids
            or {name: stage["release"][name] for name in ids} != ids
            or stage["smoke"] != {"versionId": SMOKE_VERSION, "deploymentId": SMOKE_DEPLOYMENT}):
        raise ValueError("Resumed seal differs from the exact interrupted Worker versions")
    support, approved = workflow_receipt(producer, receipt["supportArtifact"], receipt["supportSha256"], get=get, git=git)
    if (support["verifierRevision"] != receipt["supportVerifierRevision"]
            or any(support[key] != approved[key] for key in
                   ("verifierRevision", "candidateRevision", "stateProof", "instanceProof"))
            or not re.fullmatch(r"(?:[a-f0-9]{32}|[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})",
                                support.get("workflowId", ""))):
        raise ValueError("Resumed seal differs from the approved Workflow state")
    snapshot = archived_partial(get)
    if stage["release"]["snapshot"] != snapshot:
        raise ValueError("Resumed seal differs from the original captured archive")
    require_source(stage["predecessor"], plan, snapshot)
    if resealed:
        from successor_reseal import STAGING, STAGING_VERIFIER, SUPPORT, archived_staging

        if (receipt["reseal"] != STAGING or receipt["supportArtifact"] != SUPPORT["artifactId"]
                or receipt["supportSha256"] != SUPPORT["sha256"] or producer == STAGING_VERIFIER
                or git("merge-base", STAGING_VERIFIER, producer) != STAGING_VERIFIER
                or stage["release"] != archived_staging(get)):
            raise ValueError("Reseal does not preserve the exact zero-traffic assignments")


def sealed_successor(revision, reference, get=actions_get, *, verifier=None, git=git_read):
    producer = archive_revision(revision, reference, verifier, get, git)
    resumed = producer != revision
    filename = "native-fixture-successor-stage.json"
    reseal_prefix = "native-fixture-successor-resealed-"
    resealed = resumed and json.loads(get("artifacts/" + reference["artifactId"]))["name"].startswith(reseal_prefix)
    prefix = reseal_prefix if resealed else "native-fixture-successor-stage-"
    steps = reseal_steps() if resealed else (RESUMED_STAGE_STEPS if resumed else STAGE_STEPS)
    stage = artifacts(producer, reference, prefix, steps, [filename], get)[filename]
    if ("resume" in stage) != resumed:
        raise ValueError("Successor seal does not identify its archived stage operation")
    approval = stage["approval"]
    if resumed:
        if approval != dict(zip(("artifactId", "sha256"), PLAN)):
            raise ValueError("Resumed successor must retain the original protected plan")
        plan = approved_plan(revision, *PLAN, get, expected_run=PLAN_RUN)
        require_resumed_seal(stage, producer, plan, get, git, resealed=resealed)
    else:
        plan = approved_plan(revision, approval["artifactId"], approval["sha256"], get)
    require_sealed_source(revision, stage, plan)
    return stage


def continuation_steps(resumed, steps):
    if not resumed:
        return steps
    return {
        "Require closed protected planning": "success",
        "Check the reviewed edge policy": "success",
        "Authenticate the original release, receipt, and exact erasure": "skipped",
        RESUME_CAPTURE_STEP: "skipped",
        SEAL_AUTH_STEP: "success",
        **steps,
    }


def recovered_successor(revision, reference, seal, get=actions_get, *, verifier=None, git=git_read):
    producer = archive_revision(revision, reference, verifier, get, git)
    resumed = producer != revision
    filename = "native-fixture-successor-recovered.json"
    data = artifacts(producer, reference, "native-fixture-successor-recovered-",
                     continuation_steps(resumed, RECOVERY_STEPS), [filename], get)[filename]
    stage = sealed_successor(revision, seal, get, verifier=producer, git=git)
    if ("resume" in stage) != resumed or data["seal"] != seal or data["stage"] != stage:
        raise ValueError("Dormant recovery depends on another successor seal")
    promoted = data["promoted"]
    ids = [promoted[role+"DeploymentId"] for role in ("core", "public")]
    previous = [stage["release"][role+"DeploymentId"] for role in ("core", "public")]
    if (len(set(ids)) != len(ids) or set(ids).intersection(previous)
            or any(str(UUID(value)) != value for value in ids)):
        raise ValueError("Dormant successor contains invalid deployment positions")
    return data


def staged_accounting_release(recovered, get=actions_get):
    archive = STAGED_ACCOUNTING_ARTIFACT
    run, body = protected_archive(
        STAGED_ACCOUNTING_REVISION, archive["artifactId"], archive["sha256"],
        prefix="native-fixture-successor-rollout-diagnostics-", conclusions={"failure"},
        get=get, workflow=WORKFLOW,
    )
    if run != STAGED_ACCOUNTING_RUN:
        raise ValueError("Unexpected staged accounting rollout")
    inventory = json.loads(get(f"runs/{run}/attempts/1/jobs?per_page=100"))
    job, = inventory["jobs"]
    required = {
        "Reconcile the exact existing Smoke Queue consumer": "success",
        "Upload the reviewed active successor pair": "success",
        "Stage the active successor pair at zero traffic": "success",
        "Verify and promote the active successor with its tested return pair": "failure",
        "Verify the installed successor and retained controls": "skipped",
        "Restore the sealed dormant pair after failed verification": "skipped",
        "Retain successor active rollout diagnostics": "success",
    }
    steps = [(step["name"], step["conclusion"]) for step in job["steps"] if step["name"] in required]
    if inventory["total_count"] != 1 or job["name"] != "plan" or job["conclusion"] != "failure" or steps != list(required.items()):
        raise ValueError("Accounting rollout did not stop after staging")
    with ZipFile(BytesIO(body)) as evidence:
        if set(evidence.namelist()) != {"native-release.json", "native-release.json.uploads"} or len(evidence.infolist()) != 2:
            raise ValueError("Unexpected staged accounting evidence")
        if any(not 0 < file.file_size <= 128_000 for file in evidence.infolist()):
            raise ValueError("Unexpected staged accounting evidence size")
        staged = json.loads(evidence.read("native-release.json"))
        upload = json.loads(evidence.read("native-release.json.uploads"))
    immutable = {key: value for key, value in STAGED_ACCOUNTING_COORDINATES.items() if key.endswith("VersionId")}
    snapshot = staged["snapshot"]
    original = recovered["stage"]
    if (upload != immutable or {key:value for key, value in staged.items() if key != "snapshot"} != STAGED_ACCOUNTING_COORDINATES
            or snapshot["revision"] != STAGED_ACCOUNTING_REVISION or snapshot["stableRevision"] != REVISION):
        raise ValueError("Staged accounting coordinates differ from the captured rollout")
    for role, suffix in (("core", "core"), ("public", "ingress")):
        if snapshot[role] != {
            "name": "fidy-native-storage-" + suffix,
            "deploymentId": recovered["promoted"][role+"DeploymentId"],
            "stableVersionId": original["release"][role+"VersionId"],
        }:
            raise ValueError("Staged accounting coordinates differ from the tested return pair")
    if snapshot["stableContractDigest"] != original["release"]["snapshot"]["stableContractDigest"]:
        raise ValueError("Staged accounting return contract differs")
    return staged


def accounting_continuation_producer(reference, verifier, get, git):
    artifact_id = reference["artifactId"]
    if not re.fullmatch(r"[1-9][0-9]{0,19}", artifact_id or ""):
        raise ValueError("Invalid active accounting continuation archive")
    producer = json.loads(get("artifacts/" + artifact_id))["workflow_run"]["head_sha"]
    if (not re.fullmatch(r"[a-f0-9]{40}", producer or "") or producer == STAGED_ACCOUNTING_REVISION
            or git("merge-base", STAGED_ACCOUNTING_REVISION, producer) != STAGED_ACCOUNTING_REVISION
            or git("merge-base", producer, verifier) != producer):
        raise ValueError("Invalid protected accounting continuation lineage")
    return producer


def active_successor(revision, reference, get=actions_get, *, verifier=None, git=git_read):
    continuing_accounting = revision == STAGED_ACCOUNTING_REVISION
    producer = (accounting_continuation_producer(reference, verifier or git("rev-parse", "HEAD"), get, git)
                if continuing_accounting else archive_revision(revision, reference, verifier, get, git))
    resumed = producer != revision
    promotion_name, installation_name = "native-release.json.promoted", "native-verification.json"
    seal_name, recovery_name = "fixture-successor-seal-reference.json", "fixture-successor-recovery-reference.json"
    steps = {**ACTIVE_STEPS}
    if continuing_accounting:
        steps.update({
            "Capture the verified successor dormant rollback position": "skipped",
            "Upload the reviewed active successor pair": "skipped",
            "Stage the active successor pair at zero traffic": "skipped",
        })
    files = artifacts(producer, reference, "native-fixture-successor-active-",
                      continuation_steps(resumed, steps),
                      [promotion_name, installation_name, seal_name, recovery_name], get)
    promotion, installed = files[promotion_name], files[installation_name]
    accounting = installed.get("nativeAccountingWitness", False)
    if (type(accounting) is not bool or (continuing_accounting and not accounting)
            or (accounting and (revision == REVISION or (resumed and not continuing_accounting)))):
        raise ValueError("Native accounting rollout requires a new exact application")
    support = REVISION if accounting else revision
    recovered = recovered_successor(support, files[recovery_name], files[seal_name], get, verifier=producer, git=git)
    stage, promoted = recovered["stage"], recovered["promoted"]
    release = promotion["release"]
    if continuing_accounting and release != staged_accounting_release(recovered, get):
        raise ValueError("Active accounting release differs from its exact existing stage")
    snapshot = release["snapshot"]
    smoke, = [worker for worker in installed["workers"] if worker["role"] == "Smoke"]
    if (("resume" in stage) != (resumed or accounting) or promotion["rollbackTested"] is not True or snapshot["revision"] != revision
            or snapshot["stableRevision"] != support or installed["revision"] != revision
            or installed["verifierRevision"] != producer or installed["admission"] != "closed"
            or installed["fixtureMember"] != "performance-2" or installed["resourceRevision"] != support
            or installed["retainedProvider"] != stage["provider"] or installed["fixtureControlsDigest"] != stage["controlsDigest"]
            or installed["namespaces"] != [stage["namespaces"][role] for role in OWNERS]
            or installed["userNamespace"] != stage["namespaces"]["user"]
            or any(smoke[key] != value for key,value in stage["smoke"].items())):
        raise ValueError("Active successor differs from the tested dormant installation")
    for role in ("core", "public"):
        version_key, deployment_key = role+"VersionId", role+"DeploymentId"
        if (snapshot[role]["deploymentId"] != promoted[deployment_key]
                or snapshot[role]["stableVersionId"] != stage["release"][version_key]
                or release[version_key] == stage["release"][version_key]
                or ((resumed or accounting) and installed[version_key] != release[version_key])):
            raise ValueError("Active successor does not identify its tested return pair")
    return promotion, installed


def main():
    env = os.environ
    operation = env.get("FIXTURE_RELEASE_OPERATION")
    verifier = env.get("GITHUB_SHA", "")
    revision = env.get("RELEASE_GIT_SHA", verifier)
    mode = env.get("FIXTURE_SUCCESSOR_RESUME", "false")
    resumed = mode == "true"
    accounting_mode = env.get("FIXTURE_ACCOUNTING_ROLLOUT", "false")
    accounting = accounting_mode == "true"
    continuation = env.get("FIXTURE_ACCOUNTING_CONTINUATION", "false")
    continuing_accounting = continuation == "true"
    if (operation not in ("recover-fixture-successor", "rollout-fixture-successor")
            or not re.fullmatch(r"[a-f0-9]{40}", verifier)
            or mode not in ("true", "false") or accounting_mode not in ("true", "false")
            or (accounting and (resumed or revision == REVISION or operation != "rollout-fixture-successor"))
            or (resumed and (revision != REVISION or revision == verifier))
            or continuation not in ("true", "false")
            or (continuing_accounting and (not accounting or revision != STAGED_ACCOUNTING_REVISION or revision == verifier))
            or (not resumed and not continuing_accounting and revision != verifier)
            or env.get("GITHUB_ACTIONS") != "true" or env.get("GITHUB_REF_PROTECTED") != "true"
            or env.get("GITHUB_REF") != "refs/heads/trunk" or env.get("GITHUB_EVENT_NAME") != "workflow_dispatch"
            or env.get("GITHUB_WORKFLOW_REF") != WORKFLOW_REF or env.get("GITHUB_RUN_ATTEMPT") != "1"
            or env.get("NATIVE_STORAGE_ADMISSION") != "closed" or env.get("NATIVE_STORAGE_HOSTS") != "acceptance"):
        raise ValueError("Requires the protected successor workflow and exact verifier checkout")
    if (resumed or accounting) and git_read("rev-parse", "HEAD") != verifier:
        raise ValueError("Resumed successor verification requires the current checkout")
    seal = {"artifactId":env["SUCCESSOR_SEAL_ARTIFACT"], "sha256":env["SUCCESSOR_SEAL_DIGEST"]}
    if operation == "recover-fixture-successor":
        stage = sealed_successor(revision, seal, verifier=verifier)
        files = {"native-fixture-successor-stage.json":stage}
    else:
        recovery = {"artifactId":env["SUCCESSOR_RECOVERY_ARTIFACT"], "sha256":env["SUCCESSOR_RECOVERY_DIGEST"]}
        recovered = recovered_successor(REVISION if accounting else revision, recovery, seal, verifier=verifier)
        stage = recovered["stage"]
        files = {"native-fixture-successor-stage.json":stage, "native-fixture-successor-recovered.json":recovered,
                 "fixture-successor-recovery-reference.json":recovery}
        if continuing_accounting:
            if git_read("merge-base", revision, verifier) != revision:
                raise ValueError("Staged accounting application is outside the protected verifier lineage")
            files["native-release.json"] = staged_accounting_release(recovered)
    if ("resume" in stage) != (resumed or accounting):
        raise ValueError("Successor seal does not match the protected resume mode")
    files.update({"fixture-successor-seal-reference.json":seal, "fixture-successor-source.json":stage["predecessor"]})
    for name, contents in files.items():
        with (Path(env["RUNNER_TEMP"]) / name).open("x") as file:
            json.dump(contents, file)


if __name__ == "__main__":
    main()
