"""The complete admitted sequence comes from the protected frozen-package rehearsal."""

from collections import Counter
import hashlib
import json
import re
from pathlib import Path

from budget import KEYS, Refused, counts
from comparison import FIXTURE
import browser_window
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
        self.digest = pinned_manifest
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
        self.browser = plan.get("workload") == browser_window.WORKLOAD
        self.fixture = browser_window.FIXTURE if self.browser else FIXTURE
        self.user = plan.get("browserUser")
        if self.browser:
            if snapshot.get("workload") != browser_window.WORKLOAD or pairs != 30 or not self.user:
                raise Refused("incomplete_browser_fixture")
            self.assets = json.loads(checked("browser-assets"))
        if (
            plan["baseline"] != PIN
            or plan["verified"] != self.fixture
            or self.probe["result"] != "passed"
            or self.probe["comparedInspections"] != 8
            or (not self.browser and self.probe["auditReads"] != 30)
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
        if self.browser:
            allowed = browser_window.route_counts(self.expected)
            self.counts = Counter([*LOGIN, *["GET /transactions/"+i for i in self.inspections]]) + allowed
            if set(limits) != set(self.counts) | {"POST /call","POST /batch"}:
                raise Refused("unexpected_browser_worker_permissions")
            if self.counts != Counter(row["route"] for row in self.probe["requests"]):
                raise Refused("incomplete_browser_request_reservations")
            self.http = {r:counts(limits[r]["maximum"]) for r in self.counts}
            self.estimate = counts({k:sum(c[k] for c in self.direct) + sum(n*self.http[r][k] for r,n in self.counts.items()) for k in KEYS})
            if self.estimate != self.probe["fullEstimate"] or self.estimate["rowsWritten"] > 5000:
                raise Refused("invalid_complete_browser_estimate")
            return
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
