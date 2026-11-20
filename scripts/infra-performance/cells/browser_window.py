"""The single signed Transactions workload, including every credentialed browser request."""
from collections import Counter
import json
import os
from pathlib import Path
import subprocess
import time

from budget import KEYS, Refused
from comparison import BROWSER_FIXTURE as FIXTURE
ROOT = Path(__file__).resolve().parents[3]

MONTH = "/transactions?limit=25&from=2026-11-01T05%3A00%3A00.000Z&to=2026-12-01T05%3A00%3A00.000Z"
WORKLOAD = "mounted-transactions-ordinary"
AUDIT = "SELECT operation,outcome,count(*) AS n FROM audit_entries WHERE user_id=? AND session_id=? GROUP BY operation,outcome ORDER BY operation,outcome"
COMMERCIAL = "SELECT (SELECT coalesce(sum(units),0) FROM commercial_allowance_consumptions WHERE user_id=?1 AND allowance='canonical_call') AS units,(SELECT count(*) FROM canonical_request_replays WHERE user_id=?1 AND state='completed') AS receipts"


def route_counts(expected):
    target, = [row["id"] for row in expected["history"]["data"] if row["counterparty"] == "Evaluación 2"]
    return Counter({"GET /web/session/binding?context=transactions":1, "GET /web/session/binding":1,
                    "GET /ingestion/review-workspace?limit=0&status=pending":1,
                    "GET "+MONTH:30, "GET /user":30, "GET /transactions?limit=25":2,
                    "PUT /transactions/"+target:1,"POST /operations/atomic-batch":1})


def run_window(owner, bundle, context, headers, report, save):
    allowed = route_counts(bundle.expected)
    maximum = {k:sum(n*bundle.http[r][k] for r,n in allowed.items()) for k in KEYS}
    out = context["out"]
    out.mkdir(mode=0o700)
    def run():
        native_deadline = context["reserve"]()
        config = dict(d1=dict(session=dict(cookie=headers["Cookie"],binding=headers["Fidy-Session-Binding"]),
                              version=context["version"],url=context["api"],key=context["key"],assets=bundle.assets),
                      native=dict(session=context["session"],revision=context["revision"],web=context["web"]),
                      expected=bundle.expected, allowed=allowed,
                      caps={r:bundle.http[r] for r in allowed}, maximum=maximum,
                      deadline=min(owner.active["deadline"],native_deadline)*1000)
        env = {k:os.environ[k] for k in ("HOME","PATH","BROWSER_TLS_CERT","BROWSER_TLS_KEY","BROWSER_TLS_PIN",
                                          "ASSESSMENT_CHROMIUM","SMOKE_PROOF","RUNNER_TEMP") if k in os.environ}
        env["FIDY_DIAGNOSTIC_DIR"] = str(out.resolve())
        result = subprocess.run(["bun","scripts/infra-performance/hosted-browser/protected-pair.mjs"],cwd=ROOT,
                                env=env,input=json.dumps(config),text=True,timeout=max(1,min(owner.active["deadline"],native_deadline)-time.time()))
        path = out/"comparison.json"
        if path.is_file():
            report["browser"] = json.loads(path.read_bytes())
            save()
        if result.returncode or not report.get("browser",{}).get("verified"):
            raise Refused("hosted_browser_window_incomplete")
        return report["browser"]["actualD1"]
    owner.batch("mounted-30-pairs-and-scoped-corrections", maximum, run)


def audit_check(rows, rehearsal):
    # Frozen Audit may also hold presentation records with null operation and outcome.
    recorded = [r for r in rows[0]["results"] if r["operation"] is not None]
    expected = [r for r in rehearsal["sessionAudit"] if r["operation"] is not None]
    if recorded != expected or rows[1]["results"] != [dict(units=0,receipts=0)]:
        raise Refused("scoped_session_audit_or_commercial_state_mismatch")
