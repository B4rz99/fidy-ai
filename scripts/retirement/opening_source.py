"""Bind the canonical opening receipt to the exact account and serving graph."""
import re

from disposition import HOSTS, NATIVE_WORKERS
from provider import HEX_ID, UUID, require
from provenance import REVISION, SHA, authenticated_archive

OPEN_WORKFLOW = ".github/workflows/native-storage-release.yml"
OPEN_ARCHIVE = "native-canonical-signup-open-"
OPEN_FILE = "native-verification.json.canonical-open"
ACCOUNT = "a32350b6918ad7e78bc589b6630af1c2"
ZONE = "d94aec07ff939334b56ab53931609e58"
DOMAIN = re.compile(r"[a-f0-9]{32,40}")
OWNERS = {"Directory", "UserStore", "Pricing", "Maintenance", "Erasure"}


def opening_coordinates(receipt):
    revision, contract = receipt["revision"], receipt["contractDigest"]
    require(REVISION.fullmatch(revision) and SHA.fullmatch(contract) and receipt["admission"] == "open",
            "Canonical release is not sealed as open")
    workers, hosts, namespaces = [receipt[key] for key in ("workers", "hosts", "namespaces")]
    require(type(workers) is dict and set(workers) == NATIVE_WORKERS and
            all(set(value) == {"deployment", "version"} and
                UUID.fullmatch(value["deployment"]) and UUID.fullmatch(value["version"])
                for value in workers.values()), "Opening receipt Worker graph is incomplete")
    require(type(hosts) is dict and set(hosts) == set(HOSTS) and
            all(DOMAIN.fullmatch(identity) for identity in hosts.values()),
            "Opening receipt canonical host graph is incomplete")
    require(type(namespaces) is dict and len(namespaces) == len(OWNERS) and
            set(namespaces.values()) == OWNERS and all(HEX_ID.fullmatch(identity) for identity in namespaces),
            "Opening receipt native owner graph is incomplete")
    require(receipt.get("account", ACCOUNT) == ACCOUNT and receipt.get("zone", ZONE) == ZONE,
            "Receipt belongs to another Cloudflare installation")
    return {"revision": revision, "contractDigest": contract, "workers": workers, "hosts": hosts,
            "namespaces": namespaces, "account": ACCOUNT, "zone": ZONE}


def authenticated_opening(artifact, archive_sha):
    receipt, _ = authenticated_archive(artifact, archive_sha, OPEN_WORKFLOW, OPEN_FILE, OPEN_ARCHIVE)
    return opening_coordinates(receipt)

ACTIVITY_ARCHIVE = "native-canonical-signup-verified-"
ACTIVITY_FILE = "native-verification.json.canonical-activity"
ACCEPTED_RECOVERY = {
    "owner": "Maintenance",
    "outcome": "recovered",
    "kind": "accepted-workerd",
    "artifactId": "14596469892",
    "runId": "44662489274",
    "revision": "b992abd28797606fa74fb0c7a4fda91bf13dc5a4",
    "digest": "6e62f659994e237a7787ea326cda069e101344bc2b40960489a93ccaf348f5e0",
}


def verify_activity(receipt, opening, opening_archive, opening_sha):
    require(receipt.get("unresolvedPaidEffects", False) is False,
            "The protected activity verifier observed an unresolved external side effect")
    require(receipt["openingArtifact"] == opening_archive and receipt["openingSha256"] == opening_sha,
            "Native activity belongs to another canonical opening")
    require(opening_coordinates(receipt) == opening, "Native activity belongs to another serving graph")
    signup, recovery = receipt["signup"], receipt["recovery"]
    require(signup["provider"] in {"google", "microsoft"} and signup["outcome"] == "created" and
            signup["synthetic"] is False and signup["origin"] == "https://api.fidyapp.com" and
            signup["coreVersion"] == opening["workers"]["fidy-native-storage-core"]["version"] and
            signup["userNamespace"] in opening["namespaces"] and
            opening["namespaces"][signup["userNamespace"]] == "UserStore",
            "Canonical provider activity did not prove a new ordinary User")
    proof = signup["proof"]
    require(proof["kind"] in {"new-userstore", "provider-completion"} and SHA.fullmatch(proof["digest"]),
            "Ordinary signup witness is missing")
    background = receipt["background"]
    require(background["watchdogCompleted"] is True and background["canaryCompleted"] is True and
            SHA.fullmatch(background["digest"]), "Live watchdog traversal or native canary evidence is missing")
    require({key: recovery.get(key) for key in ACCEPTED_RECOVERY} == ACCEPTED_RECOVERY and
            opening["namespaces"].get(recovery["namespace"]) == "Maintenance",
            "Accepted native recovery archive differs")


def authenticated_activity(artifact, archive_sha, opening, opening_archive, opening_sha):
    receipt, _ = authenticated_archive(artifact, archive_sha, OPEN_WORKFLOW, ACTIVITY_FILE, ACTIVITY_ARCHIVE)
    verify_activity(receipt, opening, opening_archive, opening_sha)
