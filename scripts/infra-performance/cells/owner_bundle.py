"""The complete admitted sequence comes from the protected frozen-package rehearsal."""

import hashlib
import json
import re
from pathlib import Path

from budget import KEYS, Refused, counts
from comparison import FIXTURE
from prepare import PIN, CALIBRATION

LOGIN = ("POST /web/pairings", "POST /web/pairings/redeem", "GET /web/session/binding")
HISTORY = "GET /transactions?limit=25"


def sha(data):
    return hashlib.sha256(data).hexdigest()


class MaterializedBundle:
    def __init__(self, path, pinned_manifest, proof, pairs):
        manifest_data = (path / "manifest.json").read_bytes()
        if sha(manifest_data) != pinned_manifest:
            raise Refused("untrusted_package")
        manifest = json.loads(manifest_data)
        if manifest["baseline"] != PIN or manifest["calibration"] != CALIBRATION:
            raise Refused("wrong_comparator_revision")
        self.contract = manifest["contractDigest"]
        if not re.fullmatch("[a-f0-9]{64}", self.contract):
            raise Refused("missing_frozen_contract")

        def checked(name, extension="json"):
            data = (path / (name + "." + extension)).read_bytes()
            if manifest["sha256"][name] != sha(data):
                raise Refused("bundle_digest_mismatch")
            return data

        self.modules = {n: checked(n, "mjs") for n in ("bounded-ingress", "metered-core")}
        self.expected = json.loads(checked("expected"))
        self.disclosure = checked("disclosure").decode()
        self.probe = json.loads(checked("probe"))
        plan, snapshot = json.loads(checked("plan")), json.loads(checked("snapshot-proof"))
        if (
            plan["baseline"] != PIN
            or plan["verified"] != FIXTURE
            or self.probe["result"] != "passed"
            or self.probe["comparedInspections"] != 8
            or self.probe["auditReads"] != 30
            or snapshot["scope"] != "complete pre-Login fixture"
            or snapshot["stage"] != "equivalent"
            or snapshot["snapshot"] != plan["schemaSnapshot"]
            or pairs not in (1, 30)
        ):
            raise Refused("unverified_materialized_comparator")
        if any(plan["canonicalTransactionFixture"].get(k) != v for k, v in proof.items()):
            raise Refused("native_fixture_binding_mismatch")
        self.batches = [g["batch"] for g in plan["batches"]]
        self.inspections = self.expected["inspections"]
        if len(self.inspections) != 8 or len(self.expected["history"]["data"]) != 7:
            raise Refused("invalid_fixture_result_counts")
        ledger = self.probe["sqlBatches"]
        if (
            not self.batches
            or snapshot["batches"] != len(self.batches)
            or [g["phase"] for g in ledger]
            != ["calibration"] * len(self.batches) + ["identity", "approval", "audit"]
        ):
            raise Refused("incomplete_batch_bounds")
        self.direct = [counts(g["maximum"]) for g in ledger]
        routes = [*LOGIN, *["GET /transactions/" + i for i in self.inspections], HISTORY]
        limits = json.loads(checked("limits"))
        if set(limits) != set(routes):
            raise Refused("incomplete_request_bounds")
        self.http = {r: counts(limits[r]["maximum"]) for r in routes}
        bounds = self.direct + [self.http[r] for r in routes] + [self.http[HISTORY]] * (pairs - 1)
        self.estimate = counts({k: sum(cap[k] for cap in bounds) for k in KEYS})
        if self.estimate != counts(
            self.probe["fullEstimate"]["onePair" if pairs == 1 else "thirtyPairs"]
        ):
            raise Refused("incomplete_experiment_estimate")


def verified_batch(cloud, database, statements, check=None):
    replies = cloud.query(database, statements)
    actual = dict(rowsRead=0, rowsWritten=0)
    for statement, reply in zip(statements, replies, strict=True):
        if reply["success"] is not True:
            raise Refused("unsuccessful_native_batch")
        cost = counts(
            dict(rowsRead=reply["meta"]["rows_read"], rowsWritten=reply["meta"]["rows_written"])
        )
        actual = {k: actual[k] + cost[k] for k in KEYS}
        if "check" in statement:
            # Snapshot projections use ASCII column names and SQLite-rendered text values.
            stable = [sorted(row.items()) for row in reply["results"]]
            if (
                sha(json.dumps(stable, ensure_ascii=False, separators=(",", ":")).encode())
                != statement["check"]
            ):
                raise Refused("materialized_state_digest_mismatch")
    if check is not None:
        check(replies)
    return actual
