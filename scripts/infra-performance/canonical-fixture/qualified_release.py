"""Verify a successful protected native rollout and its independently approved artifact digest."""
import hashlib
from io import BytesIO
import json
from pathlib import Path
import re
import subprocess
from zipfile import ZipFile

REPO = "B4rz99/fidy-ai"
BASE = "repos/" + REPO + "/actions/"


def actions_get(path):
    return subprocess.check_output(["gh", "api", BASE + path], timeout=40)


def protected_archive(account_revision, artifact_id, expected_digest, *, prefix, conclusions, get=actions_get):
    if not re.fullmatch("[1-9][0-9]{0,19}", artifact_id or "") or not re.fullmatch("[0-9a-f]{64}", expected_digest or ""):
        raise ValueError("Exact protected rollout artifact ID and independently pinned digest required")

    meta = json.loads(get("artifacts/" + artifact_id))
    run_id = str(meta["workflow_run"]["id"])
    if not re.fullmatch("[1-9][0-9]{0,19}", run_id) or str(meta["id"]) != artifact_id:
        raise ValueError("Foreign GitHub artifact or source run")
    run = json.loads(get("runs/" + run_id))
    if (str(run["id"]) != run_id or run["repository"]["full_name"] != REPO or run["head_repository"]["full_name"] != REPO
            or run["path"] != ".github/workflows/native-storage-release.yml" or run["head_branch"] != "trunk"
            or run["head_sha"] != account_revision or run["event"] != "workflow_dispatch"
            or run["conclusion"] not in conclusions or run["run_attempt"] != 1
            or meta["expired"] is not False or meta["name"] != prefix + run_id
            or meta["workflow_run"]["head_sha"] != account_revision or not 0 < meta["size_in_bytes"] <= 1_048_576
            or meta["digest"] != "sha256:" + expected_digest):
        raise ValueError("Foreign, expired or unsuccessful protected rollout")
    data = get("artifacts/" + artifact_id + "/zip")
    if len(data) != meta["size_in_bytes"] or hashlib.sha256(data).hexdigest() != expected_digest:
        raise ValueError("Protected release archive differs")
    return run_id, data


def artifact(account_revision, artifact_id, expected_digest):
    _, data = protected_archive(account_revision, artifact_id, expected_digest,
                                prefix="native-storage-release-", conclusions={"success"})
    with ZipFile(BytesIO(data)) as archive:
        def document(name):
            items = [item for item in archive.infolist() if item.filename == name]
            if len(items) != 1 or items[0].file_size > 2_000_000:
                raise ValueError("Missing unique protected release evidence")
            return json.loads(archive.read(items[0]))
        return document("native-release.json.promoted"), document("native-verification.json")


def serving_graph(read, account, revision, installed):
    if not re.fullmatch("[0-9a-f]{64}", installed.get("fixtureControlsDigest", "")):
        raise ValueError("Protected release has no retained financial control evidence")
    recorded_provider = installed["retainedProvider"]
    pin = json.loads((Path(__file__).resolve().parents[3] / "infra/cloudflare/native-retained-provider.json").read_bytes())
    if recorded_provider != pin:
        raise ValueError("The qualified release does not retain the original closed provider")
    name = "fidy-native-smoke-" + pin["revision"]
    active = read(f"accounts/{account}/workers/scripts/{name}/deployments")["deployments"][0]
    provider_version, = active["versions"]
    if active["id"] != pin["deploymentId"] or provider_version != {"version_id":pin["versionId"], "percentage":100}:
        raise ValueError("Retained closed provider deployment changed")
    standard_buckets(read, account, installed)
    expected = {"Core":"fidy-native-storage-core", "Ingress":"fidy-native-storage-ingress",
                "Smoke":"fidy-native-smoke-"+revision, "Web":"fidy-native-web", "ForwardedEmail":"fidy-native-email"}
    workers = {item["role"]:item for item in installed["workers"]}
    if set(workers) != set(expected) or len(workers) != len(installed["workers"]):
        raise ValueError("Incomplete protected Worker qualification")
    for role, name in expected.items():
        recorded = workers[role]
        if recorded["name"] != name:
            raise ValueError("Foreign Worker in release qualification")
        deployments = read(f"accounts/{account}/workers/scripts/{name}/deployments")["deployments"]
        active = deployments[0]
        version, = active["versions"]
        if (active["id"] != recorded["deploymentId"] or version["version_id"] != recorded["versionId"]
                or version["percentage"] != 100):
            raise ValueError("A qualified native Worker deployment changed")


def standard_buckets(read, account, installed):
    expected = {"fidy-native-"+role for role in ("release-smoke", "forwarded-email", "approved-ingest-samples", "statement-staging")}
    buckets = installed["resources"]["buckets"]
    if len(buckets) != len(expected) or set(buckets) != expected:
        raise ValueError("Unexpected qualified R2 inventory")
    for bucket in buckets:
        data = read(f"accounts/{account}/r2/buckets/{bucket}")
        if data.get("name") != bucket or data.get("storage_class") != "Standard":
            raise ValueError("Native fixture requires verified Standard R2 storage")
