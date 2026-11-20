"""Materialize the native synthetic originals and their actual source identities into pinned D1."""
import json
from pathlib import Path

from fixture import digest, instant, uuid, validate_originals

SUBJECT = "24000000-0000-4000-8000-000000000481"
REQUIRED_DECISIONS = {"money": True, "direction": True, "occurredAt": True, "categoryId": True, "counterparty": True}
TRANSACTIONS = """INSERT INTO transactions(id,user_id,amount,currency,direction,counterparty,category_id,occurred_at_ms,created_at_ms,revision,user_decisions)
SELECT json_extract(value,'$.id'),?,'1000',json_extract(value,'$.currency'),'outflow',json_extract(value,'$.counterparty'),
json_extract(value,'$.categoryId'),json_extract(value,'$.occurred'),json_extract(value,'$.created'),0,json_extract(value,'$.decisions') FROM json_each(?)"""
SOURCES = """INSERT INTO source_attestations(id,user_id,transaction_id,kind,service_market,locale,time_zone,interpretation_revision,created_at_ms)
SELECT json_extract(value,'$.source'),?,json_extract(value,'$.id'),'manual','CO','es-CO','America/Bogota','manual-v1',json_extract(value,'$.created') FROM json_each(?)"""
LINK = """INSERT INTO transaction_reconciliation_decisions(user_id,first_transaction_id,second_transaction_id,state,visible_transaction_id,decided_at_ms)
VALUES(?,?,?,'linked',?,?)"""


def bind_workspace_user(plan, workspace):
    profile = workspace["profile"]["data"]
    subject = uuid(profile["id"])
    created = instant(profile["createdAt"])
    started, ends = (instant(profile["trialPeriod"][k]) for k in ("startedAt", "endsAt"))
    if (profile["serviceMarket"], profile["locale"], profile["timeZone"]) != ("CO", "es-CO", "America/Bogota") or ends - started != 604800000:
        raise ValueError("Invalid canonical browser profile")
    original = "INSERT INTO users(id,service_market,locale,time_zone,created_at_ms) VALUES (?,'CO','es-CO','America/Bogota',0)"
    statements = [stmt for batch in plan["batches"] for stmt in batch["batch"]]
    insert, = [stmt for stmt in statements if stmt["sql"] == original and stmt["params"] == [SUBJECT]]
    for stmt in statements:
        stmt["params"] = [subject if value == SUBJECT else value for value in stmt["params"]]
    insert.update(sql=original[:-2] + "?)", params=[subject, created])
    return dict(id=subject, startedAtMs=started, endsAtMs=ends)


def scoped_transaction_plan(plan, workspace):
    if workspace["review"]["data"]["pendingCount"] != 0:
        raise ValueError("Scoped Transactions browser requires an empty unrelated Review workspace")
    omitted = {"budgets", "user_documents", "recurring_plans", "recurring_plan_revisions",
               "statement_staging_objects", "statement_submissions", "ingestion_review_items"}
    seen = set()
    selected = []
    for batch in plan["batches"]:
        kept = []
        for statement in batch["batch"]:
            tokens = statement["sql"].split(maxsplit=3)
            table = tokens[2].split("(")[0] if tokens[:2] == ["INSERT", "INTO"] else ""
            if table in omitted and statement["params"]:
                seen.add(table)
            else:
                kept.append(statement)
        if kept:
            selected.append({**batch, "batch": kept})
    if seen != omitted:
        raise ValueError("Frozen preparation no longer matches the enrolled User's empty workspace")
    plan["batches"] = selected
    plan["verified"] = {**plan["verified"], "plans": 0, "revisions": 0, "review": 0}
    plan["workload"] = "mounted-transactions-ordinary"


def materialize(plan_file, directory):
    report = json.loads((directory / "manifest.json").read_text())
    coordinates = {}
    if (directory / "native-receipt.json").is_file():
        from hosted import verified_provenance
        envelope = json.loads((directory / "native-receipt.json").read_bytes())
        private, coordinates = verified_provenance(directory, revision=report["revision"], resource_prefix=envelope["resourcePrefix"])
    else:
        private = json.loads((directory / "native-local-provenance.json").read_text())
        if private.get("origin") != "disposable native workerd":
            raise ValueError("Exact native provenance has not been observed")
    originals = report["originals"]
    validate_originals(originals)
    sources = {s["transactionId"]:s for s in private["capture"]}
    if len(private["capture"]) != 8 or set(sources) != {r["id"] for r in originals}:
        raise ValueError("SourceAttestations do not belong to the exact eight originals")
    actual = []
    for row in originals:
        source = sources[row["id"]]
        decision = json.loads(source["decisions"])
        if (decision != REQUIRED_DECISIONS or (source["kind"],source["serviceMarket"],source["locale"],source["timeZone"],
            source["interpretationRevision"],source["createdAtMs"]) != ("manual","CO","es-CO","America/Bogota","manual-v1",instant(row["createdAt"]))):
            raise ValueError("Unexpected native authority or provenance")
        actual.append(dict(id=row["id"], currency=row["money"]["currency"], counterparty=row["counterparty"], categoryId=row["categoryId"],
                           occurred=instant(row["occurredAt"]), created=source["createdAtMs"], decisions=decision, source=uuid(source["id"])))
    if len({r["source"] for r in actual}) != 8:
        raise ValueError("Duplicate attestation identity")
    link, = private["links"]
    if (sorted([link["first"],link["second"]]) != sorted([report["visible"],report["suppressed"]])
            or link["visible"] != report["visible"] or type(link["decidedAtMs"]) is not int):
        raise ValueError("Mismatched native Reconciliation")
    plan = json.loads(plan_file.read_text())
    original_plan = digest(plan)
    capture, = [b for b in plan["batches"] if b["batch"][0]["sql"].startswith("INSERT INTO transactions(id,user_id,amount,currency,direction,counterparty,category_id,occurred_at_ms,created_at_ms)")]
    pair, = [b for b in plan["batches"] if b["batch"][0]["sql"].startswith("WITH RECURSIVE pairs(i) AS (")]
    if (len(capture["batch"]) != 1 or len(pair["batch"]) != 2 or capture["batch"][0]["params"][0] != SUBJECT
            or pair["batch"][1]["params"] != [SUBJECT]):
        raise ValueError("Historical fixture shape differs")
    params = [SUBJECT, json.dumps(actual, ensure_ascii=False, separators=(",", ":"))]
    capture["batch"] = [dict(sql=TRANSACTIONS, params=params), dict(sql=SOURCES, params=params)]
    pair["batch"][0] = dict(sql=LINK, params=[SUBJECT,link["first"],link["second"],link["visible"],link["decidedAtMs"]])
    plan["canonicalTransactionFixture"] = {"previousPlanDigest":original_plan, "observedOriginals":8,
                                            "nativeManifestDigest":digest(report), "nativeProvenanceDigest":digest(private), **coordinates}
    for modified in [capture, pair]:
        modified.pop("reads", None)
        modified.pop("writes", None)
    if "workspace" in report:
        if not coordinates:
            raise ValueError("Browser profile requires the original Session and signed manifest")
        scoped_transaction_plan(plan, report["workspace"])
        plan["browserUser"] = bind_workspace_user(plan, report["workspace"])
    plan_file.write_text(json.dumps(plan, separators=(",", ":")))
    return report
