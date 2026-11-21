"""Authenticate the closed successor before planning canonical Access changes."""

from io import BytesIO
import json
import os
from pathlib import Path
import re
import subprocess
import sys
from uuid import UUID
from zipfile import ZipFile

from installation import SCRIPTS, validate_candidate, validate_qualification
from qualified_release import actions_get, git_read, protected_archive, serving_graph
from staged_application import require_steps
from successor_artifacts import active_successor
from successor_source import cloudflare

WORKFLOW_REF = "B4rz99/fidy-ai/.github/workflows/native-storage-release.yml@refs/heads/trunk"
PLAN = "native-canonical-host-plan.json"
SOURCE = "native-canonical-host-source.json"
APPROVAL = "native-canonical-host-approved.json"
OPENING_ROLLBACK_STEPS = {
    "Authenticate the exact closed active source for canonical host planning": "success",
    "Capture exact closed canonical versions and the protected User Store census": "success",
    "Upload only the compatible exact canonical signup versions": "success",
    "Stage and verify both canonical signup Workers before opening": "success",
    "Open the exact canonical signup pair and verify real provider redirects": "failure",
    "Retain exact canonical signup deployment and redirect evidence": "skipped",
    "Retain native release evidence": "success",
}


def require_protected_preview(env, git=git_read):
    verifier = env.get("GITHUB_SHA", "")
    expected = {
        "GITHUB_ACTIONS": "true",
        "GITHUB_REF_PROTECTED": "true",
        "GITHUB_REF": "refs/heads/trunk",
        "GITHUB_EVENT_NAME": "workflow_dispatch",
        "GITHUB_WORKFLOW_REF": WORKFLOW_REF,
        "GITHUB_RUN_ATTEMPT": "1",
        "NATIVE_STORAGE_ADMISSION": "closed",
        "NATIVE_STORAGE_HOSTS": "staged",
    }
    if (env.get("FIXTURE_RELEASE_OPERATION") not in ("plan-stage-hosts", "transfer-canonical-hosts", "open-canonical-signup")
            or any(env.get(key) != value for key, value in expected.items())
            or re.fullmatch(r"[a-f0-9]{40}", verifier) is None
            or git("rev-parse", "HEAD") != verifier):
        raise ValueError("Requires the current protected closed canonical host planner")
    return verifier


def exact_assignment(row, deployment, versions):
    return (str(UUID(row["id"])) == deployment
            and len(row["versions"]) == len(versions)
            and {version["version_id"]: version["percentage"] for version in row["versions"]} == versions)


def verify_opening_rollback(reference, *, account, revision, versions, digest, verifier,
                            read, get=actions_get, git=git_read):
    producer = json.loads(get("artifacts/" + reference["artifactId"]))["workflow_run"]["head_sha"]
    if not re.fullmatch(r"[a-f0-9]{40}", producer) or git("merge-base", producer, verifier) != producer:
        raise ValueError("Failed opening is outside the protected verifier lineage")
    run, encoded = protected_archive(producer, reference["artifactId"], reference["sha256"],
                                     prefix="native-storage-release-", conclusions={"failure"}, get=get)
    require_steps(get, run, "failure", OPENING_ROLLBACK_STEPS)
    filename = "native-release.json.canonical-promoted"
    with ZipFile(BytesIO(encoded)) as archive:
        entries = [entry for entry in archive.infolist() if entry.filename == filename]
        if len(entries) != 1 or not 0 < entries[0].file_size <= 8192:
            raise ValueError("Failed opening lacks the exact promoted versions")
        proof = json.loads(archive.read(entries[0]))
    release = proof["release"]
    snapshot = release["snapshot"]
    if (snapshot["revision"] != producer or snapshot["stableRevision"] != revision
            or snapshot["stableContractDigest"] != digest):
        raise ValueError("Failed opening did not start from the qualified closed release")

    restored = {}
    for role, label in (("core", "core"), ("ingress", "public")):
        baseline = snapshot[label]
        stable, opened = versions[role], release[label + "VersionId"]
        if (baseline["name"] != SCRIPTS[role] or baseline["stableVersionId"] != stable
                or opened == stable or str(UUID(opened)) != opened):
            raise ValueError("Failed opening differs from the exact qualified Worker versions")
        history = read(f"accounts/{account}/workers/scripts/{SCRIPTS[role]}/deployments")["deployments"]
        current, promoted, staged, before = history[:4]
        identity = str(UUID(current["id"]))
        if (len({row["id"] for row in history[:4]}) != 4
                or not exact_assignment(current, identity, {stable: 100})
                or not exact_assignment(promoted, proof["promoted"][label + "DeploymentId"], {opened: 100})
                or not exact_assignment(staged, release[label + "DeploymentId"], {stable: 100, opened: 0})
                or not exact_assignment(before, baseline["deploymentId"], {stable: 100})):
            raise ValueError("Live provider history does not prove the exact closed rollback")
        restored[role] = identity
    return restored


def verified_source(reference, verifier, account, public_key, read, get=actions_get, *, application=None,
                    rollback=None):
    artifact_id = reference["artifactId"]
    if (re.fullmatch(r"[1-9][0-9]{0,19}", artifact_id) is None
            or re.fullmatch(r"[a-f0-9]{64}", reference["sha256"]) is None):
        raise ValueError("Canonical host plan requires a pinned protected active archive")
    revision = json.loads(get("artifacts/" + artifact_id))["workflow_run"]["head_sha"]
    if re.fullmatch(r"[a-f0-9]{40}", revision) is None:
        raise ValueError("Canonical host source archive has an invalid producer")
    revision = application or revision
    if re.fullmatch(r"[a-f0-9]{40}", revision) is None:
        raise ValueError("Canonical host source has an invalid application revision")
    promotion, installed = active_successor(revision, reference, get, verifier=verifier)
    if installed.get("nativeAccountingWitness") is not True:
        raise ValueError("Canonical host plan requires the qualified native accounting witness")
    versions = {"core": installed["coreVersionId"], "ingress": installed["publicVersionId"]}
    candidate = validate_candidate(read, account=account, revision=revision,
                                   versions=versions, public_key=public_key)
    restored = None
    if rollback is not None:
        restored = verify_opening_rollback(
            rollback, account=account, revision=revision, versions=versions, verifier=verifier,
            digest=installed["website"][0]["contractDigest"], read=read, get=get,
        )
        validate_qualification(candidate, promotion, installed, restored=restored)
        serving_graph(read, account, revision, installed, restored=restored)
    else:
        validate_qualification(candidate, promotion, installed)
        serving_graph(read, account, revision, installed)
    website, = installed["website"]
    web, = [worker for worker in installed["workers"] if worker["role"] == "Web"]
    qualified_deployments = {role: promotion["promoted"][label + "DeploymentId"]
                             for role, label in (("core", "core"), ("ingress", "public"))} if restored else candidate["deployments"]
    return {"revision": revision, "verifierRevision": verifier, "source": reference,
            "versions": versions, "deployments": qualified_deployments,
            **({"restoredDeployments": restored} if restored else {}),
            "namespaces": installed["namespaces"],
            "website": {"revision": website["revision"], "contractDigest": website["contractDigest"],
                        "version": web["versionId"], "deployment": web["deploymentId"]}}


def verified_smoke(reference, source, verifier, get=actions_get, git=git_read):
    if re.fullmatch(r"[1-9][0-9]{0,19}", reference["artifactId"]) is None:
        raise ValueError("Native correctness requires an exact protected archive ID")
    metadata = json.loads(get("artifacts/" + reference["artifactId"]))
    producer = metadata["workflow_run"]["head_sha"]
    if (re.fullmatch(r"[a-f0-9]{40}", producer) is None or git("merge-base", producer, verifier) != producer):
        raise ValueError("Native correctness archive is outside the protected verifier lineage")
    run, body = protected_archive(
        producer, reference["artifactId"], reference["sha256"], prefix="closed-native-comparison-",
        conclusions={"success"}, get=get, workflow="native-transaction-cohort.yml", suffix="-1",
    )
    inventory = json.loads(get(f"runs/{run}/attempts/1/jobs?per_page=100"))
    job, = inventory["jobs"]
    required = {
        "Prepare isolated Chromium for the native correctness smoke": "success",
        "Admit the exact release and enroll its closed performance User": "success",
        "Verify the signed native originals and build the materialized D1 package": "skipped",
        "Run the scoped comparator under its calibrated Free ceiling": "skipped",
        "Dispose only the exact performance User and verify both established survivors": "success",
        "Retain only aggregate observations": "success",
    }
    observed = [(step["name"], step["conclusion"]) for step in job["steps"] if step["name"] in required]
    if (inventory["total_count"] != 1 or job["name"] != "cohort" or job["conclusion"] != "success"
            or observed != list(required.items())):
        raise ValueError("Protected native smoke did not finish correctness and disposal")
    with ZipFile(BytesIO(body)) as archive:
        entries = archive.infolist()
        names = {"summary.json", "cleanup.json", "native-correctness.json", "origin-before-enrollment.json"}
        if (len(entries) != len(names) or {entry.filename for entry in entries} != names
                or any(not 0 < entry.file_size <= 16384 for entry in entries)):
            raise ValueError("Unexpected native-only smoke evidence")
        files = {entry.filename: json.loads(archive.read(entry)) for entry in entries}
    summary, cleanup, smoke = (files[name] for name in ("summary.json", "cleanup.json", "native-correctness.json"))
    expected = {**source["source"], "versions": source["versions"], "deployments": source["deployments"]}
    if (summary.get("scope") != "hosted native fixture" or summary.get("nativeRevision") != source["revision"]
            or summary.get("releaseSource") != expected or summary.get("originals") != 8
            or summary.get("effective") != 7 or summary.get("member") != "performance-2"
            or any(re.fullmatch(r"[a-f0-9]{64}", summary.get(field, "")) is None
                   for field in ("nativeReceiptDigest", "nativeManifestDigest"))
            or cleanup.get("fixtureMember") != "performance-2" or cleanup.get("physicalState") not in ("absent", "empty")
            or cleanup.get("retainedOneUseFence") is not True or cleanup.get("survivors") != 2
            or cleanup.get("status") != "disposed"):
        raise ValueError("Native smoke and disposal differ from the exact approved installation")
    mutation = smoke["mutation"]
    accounting = smoke["nativeAccounting"]
    origin = files["origin-before-enrollment.json"]
    if (smoke.get("scope") != "native-only hosted correctness" or smoke.get("freshVisibleTransactions") is not True
            or smoke.get("nativeWebRevision") != source["website"]["revision"]
            or mutation.get("committedCorrections") != 1 or mutation.get("failedCallIndex") != 1
            or mutation.get("committed") != mutation.get("afterRollback") or mutation.get("before") == mutation.get("committed")
            or accounting != {"verified": True, "canonicalUnits": 0, "receipts": 0, "audit": [
                ["ingestion.getReviewWorkspace", "success", 1], ["operations.executeAtomicBatch", "validation_failed", 1],
                ["transactions.listTransactions", "success", 4], ["transactions.updateTransaction", "success", 1],
                ["transactions.updateTransaction", "validation_failed", 1],
            ]} or any(re.fullmatch(r"[A-Z]{3}", origin["origins"][role]["colo"]) is None
                      for role in ("api", "browser"))):
        raise ValueError("Native correctness lacks the verified browser, atomic rollback or persisted accounting")
    return {"runId": run, "revision": producer, **reference}


def approved_plan(reference, source, verifier, get=actions_get):
    run, body = protected_archive(verifier, reference["artifactId"], reference["sha256"],
                                  prefix="native-canonical-host-plan-", conclusions={"success"}, get=get)
    job = protected_release_job(run, get)
    required = {
        "Authenticate the exact closed active source for canonical host planning": "success",
        "Verify the scoped Access plan and closed canonical cutover prerequisites": "success",
        "Retain the verified read-only canonical host plan": "success",
        "Fence the exact incumbent writers before transferring canonical hosts": "skipped",
        "Apply the approved canonical Access changes": "skipped",
        "Transfer and verify the two closed canonical hosts": "skipped",
    }
    observed = [(step["name"], step["conclusion"]) for step in job["steps"] if step["name"] in required]
    if observed != list(required.items()):
        raise ValueError("Canonical host plan has unexpected protected step outcomes")
    with ZipFile(BytesIO(body)) as archive:
        entries = archive.infolist()
        if (len(entries) != 2 or {entry.filename for entry in entries} != {PLAN, SOURCE}
                or any(not 0 < entry.file_size <= 8192 for entry in entries)):
            raise ValueError("Unexpected canonical host plan evidence")
        installed = json.loads(archive.read(SOURCE))
        plan = json.loads(archive.read(PLAN))
    if (installed != source or plan.get("applied") is not False
            or plan.get("verifierRevision") != verifier):
        raise ValueError("Approved canonical plan differs from the current protected release")
    return plan


def protected_release_job(run, get):
    inventory = json.loads(get(f"runs/{run}/attempts/1/jobs?per_page=100"))
    jobs = inventory["jobs"]
    by_name = {job["name"]: job for job in jobs}
    if (inventory["total_count"] != 2 or len(jobs) != 2 or set(by_name) != {"release", "site"}
            or any(job["status"] != "completed" for job in jobs)
            or by_name["release"]["conclusion"] != "success"
            or by_name["site"]["conclusion"] != "skipped" or by_name["site"]["steps"] != []):
        raise ValueError("Unexpected protected release jobs")
    return by_name["release"]


def strict_manifest_member(pairs):
    members = dict(pairs)
    if len(members) != len(pairs):
        raise ValueError("Opening server manifest repeats a JSON member")
    return members


def require_server_manifest(application, verifier, manifest):
    diff = subprocess.run(
        ["git", "diff", "--quiet", application, verifier, "--", manifest],
        check=False, timeout=20,
    )
    if diff.returncode == 0:
        return

    def read(revision):
        content = subprocess.check_output(["git", "show", revision + ":" + manifest], text=True, timeout=20)
        return json.loads(content, object_pairs_hook=strict_manifest_member)

    before = read(application)
    dev = before["devDependencies"]
    key = "@cloudflare/workers-types"
    if dev.get(key) != "5.20261113.1":
        raise ValueError("Opening server manifest has a different historical Workers types pin")
    expected = {**before, "devDependencies": {**dev, key: "5.20261114.1"}}
    if json.dumps(read(verifier), sort_keys=True) != json.dumps(expected, sort_keys=True):
        raise ValueError("Opening server manifest differs outside the reviewed Workers types dev pin")


def require_ordinary_source(application, verifier):
    """Allow only the reviewed, outcome-only Native provider telemetry seam during opening."""
    provider = "apps/server/cloudflare/directory/internal/provider.ts"
    reporter = "apps/server/cloudflare/directory/internal/signup-observation.ts"
    ingress = "apps/server/cloudflare/public-worker.ts"
    core = "apps/server/cloudflare/core-http/runtime.ts"
    proof_test = "apps/server/cloudflare/storage-bootstrap/release.test.ts"
    manifest = "apps/server/package.json"
    require_server_manifest(application, verifier, manifest)
    scope = ["apps/server", "packages", ":(exclude)" + manifest]
    delta = subprocess.run(
        ["git", "diff", "--quiet", application, verifier, "--", *scope],
        check=False, timeout=20,
    )
    if delta.returncode == 0:
        return
    subprocess.run(
        ["git", "diff", "--quiet", application, verifier, "--", *scope,
         *[":(exclude)" + path for path in (provider, reporter, ingress, core, proof_test)]],
        check=True, timeout=20,
    )
    baseline = subprocess.check_output(["git", "show", application + ":" + provider], text=True, timeout=20)
    current = subprocess.check_output(["git", "show", verifier + ":" + provider], text=True, timeout=20)
    expected = ('import { observeCanonicalSignup } from "./signup-observation";\n'
                'import type { NativeAcceptanceSettings } from "../../release-isolation/contract";\n'
                + baseline.replace("type Environment = ProviderConfiguration &\n",
                                   "type Environment = ProviderConfiguration &\n  NativeAcceptanceSettings &\n", 1)
                .replace("  return yield* Effect.fromResult(response);\n",
                         "  const completed = yield* Effect.fromResult(response);\n"
                         "  yield* observeCanonicalSignup({ environment, request, provider, response: completed }).pipe(\n"
                         "    Effect.when(Effect.succeed(complete))\n"
                         "  );\n"
                         "  return completed;\n", 1))
    if current != expected:
        raise ValueError("Opening application source differs outside the reviewed provider observation")

    def check_storage_probe(path, phrases):
        before = subprocess.check_output(["git", "show", application + ":" + path], text=True, timeout=20)
        after = subprocess.check_output(["git", "show", verifier + ":" + path], text=True, timeout=20)
        for original, reviewed in phrases:
            if before.count(original) != 1:
                raise ValueError("Historical storage proof source differs")
            before = before.replace(original, reviewed, 1)
        if after != before:
            raise ValueError("Opening application differs outside the reviewed read-only storage proof")

    check_storage_probe(ingress, [
        ('import { isStorageProbe } from "./storage-bootstrap/contract";',
         'import { isStorageCompatibility, isStorageProbe } from "./storage-bootstrap/contract";'),
        ('const forwardStorageProbe = Effect.fn(function* (request: Request, environment: PublicEnvironment) {\n'
         '  if (\n    environment.RECOVERY_ISOLATION !== "isolated" ||',
         'const storageProofAllowed = (request: Request, environment: PublicEnvironment): boolean =>\n'
         '  environment.RECOVERY_ISOLATION === "isolated" ||\n'
         '  (environment.NATIVE_STORAGE_ADMISSION === "open" &&\n'
         '    environment.RECOVERY_ISOLATION === "" &&\n'
         '    new URL(request.url).origin === installedOrigins.production.api &&\n'
         '    isStorageCompatibility(request));\n\n'
         'const forwardStorageProbe = Effect.fn(function* (request: Request, environment: PublicEnvironment) {\n'
         '  if (\n    !storageProofAllowed(request, environment) ||'),
    ])
    check_storage_probe(core, [
        ('  if (\n'
         '    environment.RECOVERY_ISOLATION === "isolated" &&\n'
         '    environment.MAINTENANCE !== undefined &&\n'
         '    readinessPath(request, url)\n  ) {',
         '  const readable =\n'
         '    environment.RECOVERY_ISOLATION === "isolated"\n'
         '      ? readinessPath(request, url)\n'
         '      : environment.NATIVE_STORAGE_ADMISSION === "open" &&\n'
         '        environment.RECOVERY_ISOLATION === "" &&\n'
         '        isStorageCompatibility(request);\n'
         '  if (environment.MAINTENANCE !== undefined && readable) {'),
    ])

def approved_transfer(reference, source, verifier, get=actions_get, git=git_read):
    producer = json.loads(get("artifacts/" + reference["artifactId"]))["workflow_run"]["head_sha"]
    if (re.fullmatch(r"[a-f0-9]{40}", producer) is None or source["verifierRevision"] != verifier
            or git("merge-base", producer, verifier) != producer):
        raise ValueError("Canonical host transfer is outside the protected verifier lineage")
    run, body = protected_archive(producer, reference["artifactId"], reference["sha256"],
                                  prefix="native-canonical-host-transfer-", conclusions={"success"}, get=get)
    job = protected_release_job(run, get)
    required = {
        "Authenticate the exact closed active source for canonical host planning": "success",
        "Fence the exact incumbent writers before transferring canonical hosts": "success",
        "Apply the approved canonical Access changes": "success",
        "Transfer and verify the two closed canonical hosts": "success",
        "Retain the verified closed canonical host transfer": "success",
    }
    observed = [(step["name"], step["conclusion"]) for step in job["steps"] if step["name"] in required]
    if observed != list(required.items()):
        raise ValueError("Closed canonical transfer did not pass protected verification")
    with ZipFile(BytesIO(body)) as archive:
        entry, = archive.infolist()
        if entry.filename != "native-verification.json.canonical-hosts" or not 0 < entry.file_size <= 16384:
            raise ValueError("Unexpected canonical host transfer evidence")
        transfer = json.loads(archive.read(entry))
    transferred_source = {**source, "verifierRevision": producer}
    if transfer.get("source") != transferred_source or transfer.get("admission") != "closed":
        raise ValueError("Closed canonical transfer differs from the approved native smoke")
    return {**transfer, "source": source}


def main():
    env = os.environ
    verifier = require_protected_preview(env)
    reference = {"artifactId": env["CANONICAL_SOURCE_ARTIFACT"], "sha256": env["CANONICAL_SOURCE_SHA256"]}
    rollback = {"artifactId": env.get("CANONICAL_ROLLBACK_ARTIFACT", ""),
                "sha256": env.get("CANONICAL_ROLLBACK_SHA256", "")}
    if any(rollback.values()) and (env["FIXTURE_RELEASE_OPERATION"] != "open-canonical-signup"
                                  or not all(rollback.values())):
        raise ValueError("An exact failed opening archive is only accepted for reopening")
    source = verified_source(reference, verifier, env["CLOUDFLARE_ACCOUNT_ID"],
                             env["FIDY_NATIVE_FIXTURE_PUBLIC_KEY"], cloudflare,
                             application=env.get("CANONICAL_SOURCE_REVISION"),
                             rollback=rollback if all(rollback.values()) else None)
    restored = source.pop("restoredDeployments", None)
    smoke = {"artifactId": env["CANONICAL_SMOKE_ARTIFACT"], "sha256": env["CANONICAL_SMOKE_SHA256"]}
    source["smoke"] = verified_smoke(smoke, source, verifier)
    directory = Path(env["RUNNER_TEMP"])
    if env["FIXTURE_RELEASE_OPERATION"] == "transfer-canonical-hosts":
        approval = {"artifactId": env["CANONICAL_PLAN_ARTIFACT"], "sha256": env["CANONICAL_PLAN_SHA256"]}
        plan = approved_plan(approval, source, verifier)
        with (directory / APPROVAL).open("x") as evidence:
            json.dump(plan, evidence)
    if env["FIXTURE_RELEASE_OPERATION"] == "open-canonical-signup":
        require_ordinary_source(source["revision"], verifier)
        receipt = {"artifactId": env["CANONICAL_TRANSFER_ARTIFACT"], "sha256": env["CANONICAL_TRANSFER_SHA256"]}
        transfer = approved_transfer(receipt, source, verifier)
        if restored is not None:
            source = {**source, "deployments": restored}
            transfer = {**transfer, "source": source}
        with (directory / "native-canonical-host-transfer.json").open("x") as evidence:
            json.dump(transfer, evidence)
    with (directory / SOURCE).open("x") as evidence:
        json.dump(source, evidence)


if __name__ == "__main__":
    try:
        main()
    except (KeyError, ValueError, OSError, subprocess.SubprocessError):
        sys.exit("Canonical host source could not authenticate the protected active archive or live closed deployment.")
