"""Prepare only the eight manual Transactions through one bound synthetic User's canonical API."""
from collections import Counter
from contextlib import contextmanager
from datetime import datetime, timezone
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
from uuid import UUID

EPOCH = 1794916800000
HISTORY = "/transactions?limit=25"
FIELDS = ("money", "counterparty", "direction", "categoryId", "occurredAt")


def iso(epoch):
    return datetime.fromtimestamp(epoch / 1000, timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def instant(value):
    stamp = datetime.fromisoformat(value.replace("Z", "+00:00"))
    if stamp.tzinfo is None:
        raise ValueError("Missing UTC timestamp")
    return int(stamp.timestamp() * 1000)


def uuid(value):
    if str(UUID(value)) != value:
        raise ValueError("Noncanonical identifier")
    return value


def facts(ordinal):
    purchase = 0 if ordinal == 1 else ordinal
    return dict(money=dict(amount="1000", currency=("COP", "USD")[purchase % 2]),
                counterparty=f"Evaluación {purchase}", direction="outflow",
                categoryId=f"10000000-0000-4000-8000-{1 if purchase % 3 == 0 else purchase % 15 + 2:012d}",
                occurredAt=iso(EPOCH - purchase * 60000))


def validate_originals(rows):
    if not isinstance(rows, list) or len(rows) != 8:
        raise ValueError("Expected exactly eight synthetic originals")
    expected = Counter(json.dumps(facts(i), sort_keys=True) for i in range(8))
    observed = []
    for row in rows:
        if (not isinstance(row, dict) or set(row) - {*FIELDS, "id", "revision", "createdAt", "notes"}
                or row.get("notes") is not None or row.get("revision") != 0):
            raise ValueError("Unexpected original shape or prior Correction")
        uuid(row["id"])
        instant(row["createdAt"])
        observed.append(json.dumps({k: row[k] for k in FIELDS}, sort_keys=True))
    if Counter(observed) != expected or len({r["id"] for r in rows}) != 8:
        raise ValueError("Unexpected Transaction facts or identities")


def write(path, value):
    tmp = path.with_suffix(".tmp")
    with tmp.open("w") as stream:
        json.dump(value, stream, ensure_ascii=False, indent=2)
        stream.flush()
        os.fsync(stream.fileno())
    tmp.replace(path)
    directory = os.open(path.parent, os.O_RDONLY)
    try:
        os.fsync(directory)
    finally:
        os.close(directory)


@contextmanager
def serialized(directory):
    directory.mkdir(parents=True, mode=0o700, exist_ok=True)
    with (directory / "fixture.lock").open("a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        yield


def digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, ensure_ascii=False,
                                     separators=(",", ":")).encode()).hexdigest()


def prepare(call, directory, revision, member):
    if not re.fullmatch(r"[0-9a-f]{40}", revision) or member not in ("performance-1", "performance-2"):
        raise ValueError("Only the closed performance cohort is eligible")
    with serialized(directory):
        path = directory / "progress.json"
        journal = json.loads(path.read_text()) if path.exists() else dict(revision=revision, member=member)
        if journal["revision"] != revision or journal["member"] != member:
            raise ValueError("Foreign fixture ledger")
        def submit(stage, route, payload):
            if stage in journal:
                raise ValueError("Prior submission is unresolved; no repeat mutation")
            journal[stage] = "offered"
            write(path, journal)
            call("POST", route, payload)
            journal[stage] = "acknowledged"
            write(path, journal)

        page = call("GET", HISTORY, None)
        # The browser authority carries no canonical retry receipt. Journal before either mutation
        # and read its all-or-nothing outcome after interruption instead of submitting it twice.
        if "capture" not in journal:
            if page["data"]:
                raise ValueError("Synthetic performance User already has unrelated history")
            calls = [dict(callId=f"99000000-0000-4000-8000-{i:012d}",
                          operation="transactions.createTransaction", input={"payload": facts(i)}) for i in range(8)]
            submit("capture", "/operations/atomic-batch", {"calls": calls})
            page = call("GET", HISTORY, None)
        if not page["data"]:
            raise ValueError("Prior capture has no confirmed outcome")
        if "originals" not in journal:
            validate_originals(page["data"])
            journal["originals"] = page["data"]
            write(path, journal)
        originals = journal["originals"]
        validate_originals(originals)
        pair = sorted((row for row in originals if row["counterparty"] == "Evaluación 0"),
                      key=lambda row: (instant(row["createdAt"]), row["id"]))
        visible, hidden = pair
        expected = [visible, *sorted((row for row in originals if row not in pair),
                                     key=lambda row: instant(row["occurredAt"]), reverse=True)]
        if len(page["data"]) == 8:
            if "link" in journal or sorted(page["data"], key=lambda r: r["id"]) != sorted(originals, key=lambda r: r["id"]):
                raise ValueError("Prior link is unresolved or the captured originals changed")
            submit("link", "/transactions/link", {"firstTransactionId": visible["id"], "secondTransactionId": hidden["id"]})
            page = call("GET", HISTORY, None)
        if "link" not in journal or page["data"] != expected:
            raise ValueError("Linked effective history differs from the captured originals")
        proof = call("GET", "/transactions/" + hidden["id"], None)
        association = proof["data"]["reconciliation"]
        if (association.get("kind") != "linked" or
                sorted([association["firstTransaction"], association["secondTransaction"]], key=lambda r:r["id"])
                != sorted(pair, key=lambda r:r["id"])):
            raise ValueError("The suppressed member does not prove the original pair")
        sources = []
        for row in originals:
            records = call("GET", "/transactions/" + row["id"] + "/source-attestations", None)["data"]
            if len(records) != 1:
                raise ValueError("Expected one manual SourceAttestation per original")
            source = records[0]
            if (source != dict(id=uuid(source["id"]), transactionId=row["id"], serviceMarket="CO", locale="es-CO",
                               timeZone="America/Bogota", interpretationRevision="manual-v1", createdAt=row["createdAt"], kind="manual")):
                raise ValueError("Manual capture provenance differs")
            sources.append(source)
        if len({source["id"] for source in sources}) != 8:
            raise ValueError("Repeated SourceAttestation identity")
        record = dict(revision=revision, member=member, originals=originals, sourceAttestations=sources,
                      visible=visible["id"], suppressed=hidden["id"], history=page, inspection=proof,
                      counts=dict(originals=8, effective=7, links=1, sourceAttestations=8))
        existing = directory / "manifest.json"
        if existing.exists() and json.loads(existing.read_text()) != record:
            raise ValueError("Existing fixture evidence changed")
        write(existing, record)
        return record
