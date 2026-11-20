"""Verify the exact closed candidate and its signer before opening a native provider Session."""
import hashlib
import re
from uuid import UUID

HOST = "storage-acceptance.fidyapp.com"
BROWSER = "https://storage-web-acceptance.fidyapp.com"
SCRIPTS = {"core": "fidy-native-storage-core", "ingress": "fidy-native-storage-ingress"}


def validate_candidate(read, *, account, revision, versions, public_key):
    if not re.fullmatch(r"[a-f0-9]{32}", account) or not re.fullmatch(r"[a-f0-9]{40}", revision):
        raise ValueError("Invalid protected native candidate identity")
    fingerprint = hashlib.sha256(bytes.fromhex(public_key)).hexdigest()
    base = "accounts/" + account + "/workers/"
    host, = read(base + "domains?hostname=" + HOST)
    if (host["hostname"] != HOST or host["service"] != SCRIPTS["ingress"]
            or host["enabled"] is not True or host["previews_enabled"] is not False):
        raise ValueError("Native acceptance host ownership or exposure differs")
    deployments = {}
    user_namespace = None
    for role, script in SCRIPTS.items():
        expected = versions[role]
        if str(UUID(expected)) != expected:
            raise ValueError("Invalid expected native Worker version")
        worker = base + "scripts/" + script
        deployed = read(worker + "/deployments")["deployments"][0]
        deployments[role] = str(UUID(deployed["id"]))
        active, = deployed["versions"]
        if active["version_id"] != expected or active["percentage"] != 100:
            raise ValueError("Expected native version does not own all closed traffic")
        version = read(worker + "/versions/" + expected)
        if version["id"] != expected:
            raise ValueError("Native Worker version metadata mismatch")
        rows = version["resources"]["bindings"]
        bindings = {binding["name"]: binding for binding in rows}
        if len(bindings)!=len(rows) or any(row["type"]=="d1" for row in rows):
            raise ValueError("Unexpected native storage bindings")
        expected_text = {
            "NATIVE_STORAGE_ADMISSION": "closed", "RECOVERY_ISOLATION": "isolated",
            "RELEASE_GIT_SHA": revision, "BROWSER_ORIGIN": BROWSER,
        }
        if role == "core":
            owner = bindings.get("USER_STORE", {})
            user_namespace = owner.get("namespace_id", "")
            if (owner.get("type") != "durable_object_namespace" or owner.get("class_name") != "UserStore"
                    or (owner.get("script_name") or script) != script or not re.fullmatch("[a-f0-9]{32}", user_namespace)
                    or bindings.get("SMOKE_BUCKET", {}).get("bucket_name") != "fidy-native-release-smoke"):
                raise ValueError("Native User or receipt storage owner differs")
            expected_text["NATIVE_FIXTURE_SIGNER_SHA256"] = fingerprint
            if bindings.get("NATIVE_FIXTURE_SIGNING_KEY",{}).get("type") != "secret_text":
                raise ValueError("The closed Core has no receipt signing secret")
        elif ("NATIVE_FIXTURE_SIGNING_KEY" in bindings or "NATIVE_FIXTURE_SIGNER_SHA256" in bindings
              or bindings.get("CORE", {}).get("service") != SCRIPTS["core"]):
            raise ValueError("The closed Ingress has an unexpected signer or Core target")
        for name, value in expected_text.items():
            if (bindings.get(name, {}).get("type"), bindings.get(name, {}).get("text")) != ("plain_text", value):
                raise ValueError("Native candidate release, origin or signer fingerprint differs")
    return dict(revision=revision, versions=versions, signerSha256=fingerprint,
                deployments=deployments, userNamespace=user_namespace)


def validate_qualification(candidate, promotion, installation):
    """Match independently pinned protected release artifacts to the current serving deployment."""
    release = promotion["release"]
    snapshot = release["snapshot"]
    if (promotion["rollbackTested"] is not True or installation["admission"] != "closed"
            or installation["revision"] != candidate["revision"]
            or snapshot["revision"] != candidate["revision"]
            or installation["userNamespace"] != candidate["userNamespace"]
            or not re.fullmatch("[0-9a-f]{32}", candidate["userNamespace"])):
        raise ValueError("Closed native release or rollback qualification differs")
    for role, label in (("core", "core"), ("ingress", "public")):
        version = candidate["versions"][role]
        if (snapshot[label]["name"] != SCRIPTS[role]
                or installation[label + "VersionId"] != version or release[label + "VersionId"] != version
                or promotion["promoted"][label + "DeploymentId"] != candidate["deployments"][role]):
            raise ValueError("Native deployment differs from the qualified release")
