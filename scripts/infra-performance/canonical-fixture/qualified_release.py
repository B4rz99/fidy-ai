"""Verify a successful protected native rollout and its independently approved artifact digest."""
import hashlib
from io import BytesIO
import json
from pathlib import Path
import re
import subprocess
from zipfile import ZipFile

from staged_application import APPLICATION, STAGED_IDS, git_read, require_steps, verify_tree

REPO = "B4rz99/fidy-ai"
BASE = "repos/" + REPO + "/actions/"


def actions_get(path):
    return subprocess.check_output(["gh", "api", BASE + path], timeout=40)


def protected_archive(account_revision, artifact_id, expected_digest, *, prefix, conclusions, get=actions_get,
                      workflow="native-storage-release.yml", suffix=""):
    if not re.fullmatch("[1-9][0-9]{0,19}", artifact_id or "") or not re.fullmatch("[0-9a-f]{64}", expected_digest or ""):
        raise ValueError("Exact protected rollout artifact ID and independently pinned digest required")

    meta = json.loads(get("artifacts/" + artifact_id))
    run_id = str(meta["workflow_run"]["id"])
    if not re.fullmatch("[1-9][0-9]{0,19}", run_id) or str(meta["id"]) != artifact_id:
        raise ValueError("Foreign GitHub artifact or source run")
    run = json.loads(get("runs/" + run_id))
    if (str(run["id"]) != run_id or run["repository"]["full_name"] != REPO or run["head_repository"]["full_name"] != REPO
            or run["path"] != ".github/workflows/" + workflow or run["head_branch"] != "trunk"
            or run["head_sha"] != account_revision or run["event"] != "workflow_dispatch"
            or run["conclusion"] not in conclusions or run["run_attempt"] != 1
            or meta["expired"] is not False or meta["name"] != prefix + run_id + suffix
            or meta["workflow_run"]["head_sha"] != account_revision or not 0 < meta["size_in_bytes"] <= 1_048_576
            or meta["digest"] != "sha256:" + expected_digest):
        raise ValueError("Foreign, expired or unsuccessful protected rollout")
    data = get("artifacts/" + artifact_id + "/zip")
    if len(data) != meta["size_in_bytes"] or hashlib.sha256(data).hexdigest() != expected_digest:
        raise ValueError("Protected release archive differs")
    return run_id, data


def archive_verifier(artifact_id, checkout, get, git, application=APPLICATION):
    if not re.fullmatch("[1-9][0-9]{0,19}", artifact_id or ""):
        raise ValueError("Invalid protected artifact ID")
    source = json.loads(get("artifacts/" + artifact_id))["workflow_run"]["head_sha"]
    verify_tree(source, git, application)
    if git("merge-base", source, checkout) != source:
        raise ValueError("Protected evidence came from a different verifier lineage")
    return source


ROLLOUT_STEPS = {
    "Bind the protected verifier to the staged application source": "success",
    "Upload the verified native candidates": "success",
    "Stage the zero-traffic native candidates": "success",
    "Requalify the archived zero-traffic pair without moving traffic": "skipped",
    "Finish only the tested closed forward repair": "skipped",
    "Verify mixed and candidate versions before promoting closed admission": "success",
    "Verify the installed application and retained schema markers": "success",
    "Exercise the tested code-only rollback": "skipped",
    "Retain native release evidence": "success",
}


def artifact(account_revision, artifact_id, expected_digest, get=actions_get, git=git_read):
    if not re.fullmatch("[a-f0-9]{40}", account_revision):
        raise ValueError("Unexpected signed application revision")
    if not re.fullmatch("[1-9][0-9]{0,19}", artifact_id or ""):
        raise ValueError("Invalid protected artifact ID")
    meta = json.loads(get("artifacts/" + artifact_id))
    if meta["name"].startswith("native-fixture-successor-active-"):
        from successor_artifacts import active_successor
        if git("merge-base", account_revision, git("rev-parse", "HEAD")) != account_revision:
            raise ValueError("Protected successor release came from a different lineage")
        return active_successor(account_revision, {"artifactId":artifact_id, "sha256":expected_digest}, get)
    source = archive_verifier(artifact_id, git("rev-parse", "HEAD"), get, git, account_revision)
    run, data = protected_archive(source, artifact_id, expected_digest,
                                  prefix="native-storage-release-", conclusions={"success"}, get=get)
    require_steps(get, run, "success", ROLLOUT_STEPS)
    with ZipFile(BytesIO(data)) as archive:
        def document(name):
            items = [item for item in archive.infolist() if item.filename == name]
            if len(items) != 1 or items[0].file_size > 2_000_000:
                raise ValueError("Missing unique protected release evidence")
            return json.loads(archive.read(items[0]))
        promotion = document("native-release.json.promoted")
        installed = document("native-verification.json")
        member = installed.get("fixtureMember")
        if "fixtureMember" in installed and (member != "performance-2" or account_revision == APPLICATION):
            raise ValueError("Unexpected approved native fixture member")
        if account_revision != APPLICATION:
            from pairing_stage import sealed_pair, requires_restored_source, restored_source, OWNERS
            seal = document("native-release.json.seal")
            stage, predecessor = sealed_pair(source, seal["artifactId"], seal["sha256"], get, git)
            smoke, = [worker for worker in installed["workers"] if worker["role"] == "Smoke"]
            if (stage["revision"] != account_revision or stage.get("fixtureMember") != member
                    or installed["fixtureControlsDigest"] != stage["controlsDigest"]
                    or installed["retainedProvider"] != stage["provider"]
                    or installed["namespaces"] != [stage["namespaces"][role] for role in OWNERS]
                    or installed["userNamespace"] != stage["namespaces"]["user"]
                    or any(smoke[k] != v for k, v in stage["smoke"].items())):
                raise ValueError("Active rollout differs from its authenticated replacement")
            dormant = stage["release"]
            if requires_restored_source(account_revision, source, git):
                restored = restored_source(source, stage, predecessor, seal, get, git)
                if (document("native-release.json.restored-source") != restored
                        or any(promotion["release"]["snapshot"][role]["deploymentId"] != restored["restored"][role + "DeploymentId"]
                               for role in ("core", "public"))):
                    raise ValueError("Active rollout did not start from the exact protected restoration")
        else:
            dormant = STAGED_IDS
    release = promotion["release"]
    snapshot = release["snapshot"]
    if (snapshot["revision"] != account_revision or snapshot["stableRevision"] != account_revision
            or installed["revision"] != account_revision or installed.get("verifierRevision") != source or promotion["rollbackTested"] is not True):
        raise ValueError("Active release did not exercise the dormant application build as its rollback")
    for role in ("public", "core"):
        version = role + "VersionId"
        if snapshot[role]["stableVersionId"] != dormant[version] or release[version] == dormant[version]:
            raise ValueError("Active rollout did not start from the authenticated dormant versions")
    return promotion, installed


def retained_provider():
    return json.loads((Path(__file__).resolve().parents[3] / "infra/cloudflare/native-retained-provider.json").read_bytes())


def fixture_upload():
    return json.loads((Path(__file__).resolve().parents[3] / "infra/cloudflare/native-fixture-upload.json").read_bytes())


def serving_graph(read, account, revision, installed):
    upload = fixture_upload()
    support = upload["revision"]
    successor = installed.get("fixtureMember") == "performance-2"
    generation = revision if successor else support
    if (installed.get("revision") != revision or installed.get("resourceRevision") != generation
            or not re.fullmatch("[0-9a-f]{40}", generation)):
        raise ValueError("Qualified application source or retained resource generation differs")
    websites = installed.get("website")
    if not isinstance(websites, list) or len(websites) != 1:
        raise ValueError("Missing qualified acceptance website")
    website = websites[0]
    if (website.get("browser") != "https://storage-web-acceptance.fidyapp.com"
            or website.get("api") != "https://storage-acceptance.fidyapp.com"
            or website.get("revision") != support or not website.get("entryAssets")):
        raise ValueError("Acceptance website does not serve the retained build")
    controls = installed.get("fixtureControlsDigest", "")
    if not re.fullmatch("[0-9a-f]{64}", controls) or controls != upload["controlsDigest"]:
        raise ValueError("Protected release differs from pinned retained financial control evidence")
    recorded_provider = installed["retainedProvider"]
    pin = retained_provider()
    if recorded_provider != pin:
        raise ValueError("The qualified release does not retain the original closed provider")
    name = "fidy-native-smoke-" + pin["revision"]
    active = read(f"accounts/{account}/workers/scripts/{name}/deployments")["deployments"][0]
    provider_version, = active["versions"]
    if active["id"] != pin["deploymentId"] or provider_version.get("version_id") != pin["versionId"] or provider_version.get("percentage") != 100:
        raise ValueError("Retained closed provider deployment changed")
    standard_buckets(read, account, installed)
    expected = {"Core":"fidy-native-storage-core", "Ingress":"fidy-native-storage-ingress",
                "Smoke":"fidy-native-smoke-"+generation, "Web":"fidy-native-web", "ForwardedEmail":"fidy-native-email"}
    workers = {item["role"]:item for item in installed["workers"]}
    if set(workers) != set(expected) or len(workers) != len(installed["workers"]):
        raise ValueError("Incomplete protected Worker qualification")
    for role, name in expected.items():
        recorded = workers[role]
        if recorded["name"] != name:
            raise ValueError("Foreign Worker in release qualification")
        if role in ("Core", "Ingress"):
            if recorded["versionId"] != installed["coreVersionId" if role == "Core" else "publicVersionId"]:
                raise ValueError("Serving pair differs from the qualified application")
        elif role == "Smoke":
            if any(recorded[key] == upload["support"][role][key] for key in ("versionId", "deploymentId")):
                raise ValueError("Technical smoke receiver did not deploy the repaired source")
        elif any(recorded[key] != upload["support"][role][key] for key in ("versionId", "deploymentId")):
            raise ValueError("Retained support Worker differs from the independently pinned deployment")
        deployments = read(f"accounts/{account}/workers/scripts/{name}/deployments")["deployments"]
        active = deployments[0]
        version, = active["versions"]
        if (active["id"] != recorded["deploymentId"] or version["version_id"] != recorded["versionId"]
                or version["percentage"] != 100):
            raise ValueError("A qualified native Worker deployment changed")
        if role in ("Smoke", "ForwardedEmail"):
            raw = read(f"accounts/{account}/workers/scripts/{name}/versions/{recorded['versionId']}")
            rows = raw["resources"]["bindings"]
            bindings = {row["name"]: row for row in rows}
            source = bindings.get("RELEASE_GIT_SHA", {})
            expected_source = revision if role == "Smoke" else support
            if (raw.get("id") != recorded["versionId"] or len(bindings) != len(rows)
                    or (source.get("type"), source.get("text")) != ("plain_text", expected_source)):
                raise ValueError("Installed support Worker has a different source revision")
            if role == "Smoke":
                queue, workflow = bindings.get("SMOKE_QUEUE_NAME", {}), bindings.get("SMOKE_WORKFLOW", {})
                if ((queue.get("type"), queue.get("text")) != ("plain_text", name)
                        or (workflow.get("type"), workflow.get("workflow_name"), workflow.get("class_name"),
                            workflow.get("script_name", name)) != ("workflow", name, "ReleaseSmokeWorkflowV2", name)):
                    raise ValueError("Repaired smoke receiver targets a different resource generation")


def standard_buckets(read, account, installed):
    expected = {"fidy-native-"+role for role in ("release-smoke", "forwarded-email", "approved-ingest-samples", "statement-staging")}
    buckets = installed["resources"]["buckets"]
    if len(buckets) != len(expected) or set(buckets) != expected:
        raise ValueError("Unexpected qualified R2 inventory")
    for bucket in buckets:
        data = read(f"accounts/{account}/r2/buckets/{bucket}")
        if data.get("name") != bucket or data.get("storage_class") != "Standard":
            raise ValueError("Native fixture requires verified Standard R2 storage")
