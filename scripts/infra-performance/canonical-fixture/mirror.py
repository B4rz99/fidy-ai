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


def materialize(plan_file, directory):
    report = json.loads((directory / "manifest.json").read_text())
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
                                            "nativeManifestDigest":digest(report), "nativeProvenanceDigest":digest(private)}
    # Rehearsal recalculates actual native costs and per-batch ceilings for this exact plan.
    for modified in [capture, pair]:
        modified.pop("reads", None)
        modified.pop("writes", None)
    plan_file.write_text(json.dumps(plan, separators=(",", ":")))
    return report
