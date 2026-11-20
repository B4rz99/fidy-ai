"""Run or recover one protected, fully materialized frozen D1 Transaction comparison."""

import argparse
import json
import os
from pathlib import Path
import secrets
import subprocess
import sys
import time
from uuid import UUID, uuid4

from budget import Refused, admit, counts, today
import browser_window
from comparison import FIXTURE, boundaries, observe
from owner_bundle import MaterializedBundle, verified_batch, LOGIN, HISTORY, sha
from owner_cloud import Cloud, RejectedControlRequest, ROLES
from owner_state import AccountExperiment, CustodyObject
from owner_transport import HERE, ROOT, NATIVE_API, NATIVE_BROWSER, cloudflare, confirmed, fetch, usage
from prepare import PIN

SUBJECT = "24000000-0000-4000-8000-000000000481"
ORIGIN = "https://app.fidyapp.com"
TRIAL_MS = 7 * 24 * 60 * 60 * 1000


def require_empty_inventory(cloud):
    if cloud.namespaces() or any(cloud.identity(role) is not None for role in ROLES):
        raise Refused("disposable_namespace_collision")


def prepare_inventory(owner, cloud):
    run = owner.available()
    cloud.ownership = run["ownership"]
    cloud.control = owner.control
    require_empty_inventory(cloud)
    for role in ROLES:
        owner.available()
        run["inventory"][role] = {"id": None}
        owner.save()
        try:
            identity = cloud.create(role)
        except RejectedControlRequest:
            del run["inventory"][role]
            owner.save()
            raise
        if not identity:
            raise Refused("created_identity_unconfirmed")
        run["inventory"][role]["id"] = identity
        owner.save()
        if cloud.identity(role) != identity:
            raise Refused("created_identity_mismatch")
        if role in ("core", "ingress"):
            cloud.expose(role, False)


def teardown(owner, cloud, resumed=False):
    run = owner.active
    if run is None and owner.state["last"] and owner.state["last"]["prefix"] == cloud.prefix:
        last = owner.state["last"]
        cloud.ownership = last["ownership"]
        cloud.verify_absent(last["inventory"], last["namespaceIds"])
        return last
    if run is None or cloud.prefix != run["prefix"]:
        raise Refused("cleanup_ownership_unavailable")
    if resumed and time.time() < run["deadline"] + 90:
        raise Refused("active_owner_may_still_be_running")
    cloud.ownership = run["ownership"]
    if run["cleaning"] and time.time() < run["cleanupUntil"]:
        raise Refused("cleanup_owner_in_flight")
    run["cleaning"] = True
    run["cleanupUntil"] = int(time.time()) + 90
    cloud.control = lambda method, path: owner.control(method, path, cleanup=True)
    recorded = run.get("namespaceIds", [])
    run["namespaceIds"] = (
        sorted(set(recorded) | set(cloud.namespaces(recorded)))
        if "core" in run["inventory"]
        else recorded
    )
    owner.save()
    uncertain = []
    for role in reversed(ROLES):
        recorded = run["inventory"].get(role)
        if recorded is None:
            continue
        identity = cloud.identity(role)
        if recorded["id"] is None and identity is None and not resumed:
            uncertain.append(role)
            continue
        if identity is not None:
            if recorded["id"] is None and role in ("bucket", "db"):
                uncertain.append(role)
                continue
            if recorded["id"] is not None and recorded["id"] != identity:
                raise Refused("owned_resource_replaced")
            if recorded["id"] is None:
                recorded["id"] = identity
                owner.save()
            cloud.remove(role, identity)
        if cloud.identity(role) is not None:
            raise Refused("disposal_unconfirmed")
    if uncertain:
        raise Refused("provider_creation_receipt_unresolved_" + "_".join(uncertain))
    cloud.verify_absent(run["inventory"], run["namespaceIds"])
    previous = owner.prior(run["day"])
    owner.state["charged"] = dict(
        day=run["day"], spent={k: previous[k] + run["spent"][k] for k in previous}
    )
    owner.state["last"] = dict(
        prefix=run["prefix"],
        ownership=run["ownership"],
        day=run["day"],
        spent=run["spent"],
        pending=run["pending"],
        removed=sorted(run["inventory"]),
        inventory=run["inventory"],
        namespaceIds=run["namespaceIds"],
        namespacesAbsent=True,
        controlDispatches=run.get("controlDispatches", 0),
    )
    owner.state["active"] = None
    owner.save()
    return owner.state["last"]


def cleanup_evidence(owner, cloud, resumed=False):
    receipt = teardown(owner, cloud, resumed=resumed)
    wire = json.dumps(receipt, sort_keys=True, separators=(",", ":")).encode()
    return dict(
        removed=receipt["removed"], namespaceCount=len(receipt["namespaceIds"]),
        namespacesAbsent=receipt["namespacesAbsent"], spent=receipt["spent"],
        pending=receipt["pending"], controlDispatches=receipt["controlDispatches"],
        privateReceiptSha256=sha(wire),
    )


def statement(sql, *args):
    return dict(sql=sql, params=[str(value) for value in args])


def assert_equal(left, right, reason):
    if left != right:
        raise Refused(reason)


def exercise(owner, cloud, bundle, send, native, versions, key, pairs, report, save, browser=None):
    db = owner.active["inventory"]["db"]["id"]

    def batch(name, cap, stmts, check=None):
        return owner.batch(name, cap, lambda: verified_batch(cloud, db, stmts, check))

    for i, stmts in enumerate(bundle.batches):
        batch("materialize-" + str(i), bundle.direct[i], stmts)
    cloud.request("PUT", cloud.marker(), b"initial", "application/octet-stream", raw=True)
    assert_equal(cloud.request("GET", cloud.marker(), raw=True), b"initial", "generation_missing")
    now = int(time.time() * 1000)
    subject = bundle.user["id"] if browser else SUBJECT
    started = bundle.user["startedAtMs"] if browser else now
    ends = bundle.user["endsAtMs"] if browser else now + TRIAL_MS
    batch(
        "identity",
        bundle.direct[-3],
        [
            statement(
                "UPDATE users SET whatsapp_portfolio_id=?,whatsapp_bsuid=?,whatsapp_verified_at_ms=?,trial_started_at_ms=?,trial_ends_at_ms=? WHERE id=?",
                "acceptance-portfolio",
                "CO.Reference",
                now,
                started,
                ends,
                subject,
            ),
            statement(
                "INSERT INTO consent_history(record_type,id,user_id,disclosure_json,disclosure_message_id,decision_message_id,decision_received_at_ms,occurred_at_ms) VALUES ('processing_grant',?,?,?,?,?,?,?)",
                uuid4(),
                subject,
                bundle.disclosure,
                "disclosure",
                "decision",
                now,
                now,
            ),
        ],
    )
    headers = {"Origin": ORIGIN, "x-fidy-comparison-key": key}

    def request(route, body=None):
        method, path = route.split(" ", 1)
        frame = []

        def dispatch():
            status, reply, data = send(method, path, headers, body)
            assert_equal(
                reply.get("x-fidy-comparison-worker"), versions["ingress"], "unrecognized_ingress"
            )
            frame.append((status, reply, data))
            return counts(json.loads(reply.get("x-fidy-comparison-cost", "null")))

        owner.batch(
            "inspect-original" if route.startswith("GET /transactions/") else route,
            bundle.http[route],
            dispatch,
        )
        return frame[0]

    def successful(route, body=None):
        status, reply, data = request(route, body)
        assert_equal(status, 200, "canonical_request_failed")
        return reply, json.loads(data)

    _, start = successful(LOGIN[0])
    batch(
        "approval",
        bundle.direct[-2],
        [
            statement(
                "UPDATE browser_login_pairings SET approval_portfolio_id=?,approval_message_id=?,approval_user_id=? WHERE id=? AND state='pending_approval' AND approval_message_id IS NULL",
                "acceptance-portfolio",
                uuid4(),
                subject,
                start["pairingId"],
            )
        ],
    )
    reply, _ = successful(
        LOGIN[1], json.dumps({k: start[k] for k in ("pairingId", "privateVerifier")}).encode()
    )
    cookie = reply["set-cookie"].split(";", 1)[0]
    if not cookie.startswith("__Host-fidy_session="):
        raise Refused("missing_fresh_session")
    headers["Cookie"] = cookie
    _, binding = successful(LOGIN[2])
    headers["Fidy-Session-Binding"] = binding["binding"]
    for ident, expected in bundle.inspections.items():
        _, payload = successful("GET /transactions/" + ident)
        assert_equal(payload, expected, "original_inspection_mismatch")
        time.sleep(1)

    if browser:
        browser_window.run_window(owner,bundle,browser,headers,report,save)
        batch("audit",bundle.direct[-1],[statement(browser_window.AUDIT,subject,binding["binding"]),
              statement(browser_window.COMMERCIAL,subject)],lambda rows:browser_window.audit_check(rows,bundle.probe))
        report.update(scope=browser_window.WORKLOAD,verifiedInspections=8,verifiedHistoryAudits=33)
        return

    def verify(body):
        assert_equal(json.loads(body), bundle.expected["history"], "effective_history_mismatch")

    for pair in range(pairs):
        for variant in ("do", "d1") if pair % 2 else ("d1", "do"):
            if variant == "d1":

                def observation():
                    cost = None

                    def read(_, path):
                        nonlocal cost
                        status, reply, body = send("GET", path, headers, None)
                        if reply.get("x-fidy-comparison-worker") == versions["ingress"]:
                            cost = counts(json.loads(reply.get("x-fidy-comparison-cost", "null")))
                        return status, reply, body

                    row = observe(
                        read, variant, pair, 0, None, "transactions.page", verify
                    )
                    report["attempts"].append(row)
                    save()
                    return cost

                owner.batch("observe-history", bundle.http[HISTORY], observation)
            else:
                read = native()
                report["attempts"].append(
                    observe(read, variant, pair, 0, None, "transactions.page", verify)
                )
                save()
            if not report["attempts"][-1]["ok"]:
                raise Refused("observed_transaction_read_failed")
        time.sleep(1)

    def audit(replies):
        assert_equal(replies[0]["results"], [{"n": pairs}], "audit_count_mismatch")

    batch(
        "audit",
        bundle.direct[-1],
        [
            statement(
                "SELECT count(*) AS n FROM audit_entries WHERE user_id=? AND operation='transactions.listTransactions' AND outcome='success'",
                SUBJECT,
            )
        ],
        audit,
    )
    measured = boundaries(report["attempts"], pairs, 1)
    measured["scheduledMs"] = dict(status="missing", reason="no_independent_offered_schedule")
    report.update(
        boundaries=measured,
        verifiedHistoryAudits=pairs,
        verifiedInspections=8,
    )


def native_read(session, revision, reserve):
    def sign():
        proof = subprocess.run(
            ["bun", str(HERE / "sign.mjs")],
            input=json.dumps({**session, "revision": revision}),
            cwd=ROOT,
            capture_output=True,
            text=True,
            timeout=15,
            check=True,
        )
        if not proof.stdout:
            raise Refused("missing_native_proof")
        return proof.stdout

    def prepared():
        deadline = reserve()
        proof = sign()

        def read(_, path):
            if time.time() >= deadline:
                raise Refused("native_read_lease_expired")
            return fetch(
                NATIVE_API + path,
                {
                    "Origin": NATIVE_BROWSER,
                    "Cookie": session["cookie"],
                    "Fidy-Session-Binding": session["binding"],
                    "x-fidy-acceptance-proof": proof,
                },
            )

        return read

    return prepared


def approved_versions(core, ingress):
    versions = dict(core=core, ingress=ingress)
    for value in versions.values():
        try:
            if not value or str(UUID(value)) != value:
                raise ValueError()
        except ValueError:
            raise Refused("approved_native_worker_versions_required") from None
    return versions


def native_installation(account, revision, versions):
    from installation import validate_candidate
    public_key = os.environ.get("FIDY_NATIVE_FIXTURE_PUBLIC_KEY")
    if not public_key:
        raise Refused("protected_native_signer_pin_missing")
    try:
        return validate_candidate(cloudflare, account=account, revision=revision,
                                  versions=versions, public_key=public_key)
    except (ValueError, KeyError, TypeError):
        raise Refused("native_installation_does_not_match_approved_candidate") from None


def verified_comparator(args, report):
    if args.action == "preflight" and not all((args.fixture, args.bundle, args.revision, args.manifest_sha256)):
        raise Refused("missing_comparator_preflight_package")
    sys.path.insert(0, str(HERE.parent / "canonical-fixture"))
    try:
        from hosted import verify_native_fixture, read_native_session
    except ModuleNotFoundError as error:
        if error.name != "hosted":
            raise
        raise Refused("protected_native_receipt_verifier_missing") from None

    proof = verify_native_fixture(
        args.fixture, revision=args.revision, resource_prefix=args.prefix, member=None
    )
    if (
        proof["member"] not in ("performance-1", "performance-2")
        or proof["resourcePrefix"] != args.prefix
        or proof["nativeRevision"] != args.revision
    ):
        raise Refused("wrong_native_fixture_scope")
    bundle = MaterializedBundle(args.bundle, args.manifest_sha256, proof, args.pairs)
    if args.browser_workspace != bundle.browser:
        raise Refused("wrong_requested_workload")
    if bundle.browser:
        native_manifest = json.loads((args.fixture/"manifest.json").read_bytes())
        if (bundle.expected != {k:native_manifest[k] for k in ("history","inspections","workspace")}
            or bundle.user["id"] != native_manifest["workspace"]["profile"]["data"]["id"]):
            raise Refused("foreign_browser_workspace")
    session = read_native_session(args.fixture)
    if not all(session.get(k) for k in ("cookie", "binding")):
        raise Refused("missing_native_session")
    report.update(
        maximum=bundle.estimate,
        pairs=args.pairs,
        packageSha256=args.manifest_sha256,
        costedD1Batches=len(bundle.direct),
        costedD1Requests=sum(bundle.counts.values()) if bundle.browser else len(LOGIN) + len(bundle.inspections) + args.pairs,
        batchReservationAndReconciliationPuts=2 * (len(bundle.direct) + len(LOGIN) + len(bundle.inspections) + (1 if bundle.browser else args.pairs)),
        baseline=PIN,
    )
    report["rehearsalRevision" if args.action == "preflight" else "nativeRevision"] = args.revision
    size = subprocess.run(
        ["bun", "scripts/infra-performance/d1-budget.ts", "--estimate-only"],
        cwd=ROOT,
        input=json.dumps(bundle.estimate),
        capture_output=True,
        text=True,
        timeout=15,
    )
    if size.returncode != 1 or json.loads(size.stdout) != {
        "_tag": "NeedsAccountObservation"
    }:
        raise Refused("experiment_too_large_or_invalid")
    return bundle, proof, session


def require_approved_cost(args, bundle):
    if args.maximum_reads is None or bundle.estimate["rowsRead"] > args.maximum_reads:
        raise Refused("outside_approved_cost_proposal")


def available_cost(owner, account, estimate):
    observation = usage(account)
    day = observation["utcDate"]
    return admit(ROOT, account, observation, owner.full_estimate(estimate, day)), day


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=("preflight", "propose", "run", "cleanup"))
    parser.add_argument("--core-version", help="Approved deployed native Core version UUID")
    parser.add_argument("--ingress-version", help="Approved deployed native Ingress version UUID")
    for name in ("bundle", "fixture", "out"):
        parser.add_argument("--" + name, type=Path, required=(name == "out"))
    for name in ("prefix", "revision", "manifest-sha256"):
        parser.add_argument("--" + name, required=(name == "prefix"))
    parser.add_argument(
        "--maximum-reads", type=int, help="Explicit approved D1 ceiling for this run"
    )
    parser.add_argument("--browser-workspace", action="store_true")
    parser.add_argument("--pairs", type=int, choices=(1, 30), default=1)
    args = parser.parse_args()
    os.umask(0o077)
    args.out.mkdir(parents=True, exist_ok=False)
    report = dict(
        status="missing",
        scope="isolated Transaction history",
        attempts=[],
        lifecycle="unobserved",
        acceptance="missing",
    )

    def save():
        (args.out / "report.json").write_text(json.dumps(report, indent=2))

    save()
    try:
        if args.action in ("propose", "run"):
            bundle, proof, session = verified_comparator(args, report)
            if args.action == "propose":
                report["status"] = "verified cost proposal"
                return 0
            require_approved_cost(args, bundle)
            approved_native = approved_versions(args.core_version, args.ingress_version)
        account = os.environ["CLOUDFLARE_ACCOUNT_ID"]
        if args.action == "run":
            report["nativeCandidate"] = native_installation(account, args.revision, approved_native)
            from hosted import private_file
            from protected_cohort import comparable_native_reads, checked_browser_origin
            if bundle.browser:
                checked_browser_origin(args.fixture.parent/"origin-before-d1.json",time.time())
            reserve_native = comparable_native_reads(account, report["nativeCandidate"], proof, args.pairs, browser=bundle.browser)
        cloud = Cloud(account, args.prefix)
        owner = AccountExperiment(
            CustodyObject(account, cloud, read_only=args.action == "preflight"), account
        )
        if args.action == "preflight":
            owner.require_unclaimed(args.prefix)
            require_empty_inventory(cloud)
            bundle, _, _ = verified_comparator(args, report)
            require_approved_cost(args, bundle)
            decision, day = available_cost(owner, account, bundle.estimate)
            report.update(preflight=dict(day=day, decision=decision, applied=False))
        elif args.action == "cleanup":
            report["cleanup"] = cleanup_evidence(owner, cloud, resumed=True)
        else:
            read = None if bundle.browser else native_read(session, args.revision, reserve_native)
            decision, observed_day = available_cost(owner, account, bundle.estimate)
            owner.begin(args.prefix, decision, observed_day)
            try:
                prepare_inventory(owner, cloud)
                key = secrets.token_urlsafe(40)
                active = owner.available()
                db = active["inventory"]["db"]["id"]
                versions = cloud.deploy(bundle, db, key, active["deadline"])
                namespaces = cloud.namespaces()
                if len(namespaces) != 1:
                    raise Refused("missing_isolated_coordinator")
                active["namespaceIds"] = namespaces
                owner.save()
                receipt = dict(resourcePrefix=args.prefix, accountId=account, versions=versions,
                               databaseId=db, fixture=bundle.fixture, baseline=PIN, day=today(), namespaceId=namespaces[0],
                               packageDigest=bundle.digest, contractDigest=bundle.contract)
                confirmed(receipt, account, exposed=False)
                cloud.expose("ingress", True)
                api = confirmed(receipt, account, exposed=True)

                def send(method, path, headers, body):
                    return fetch(
                        api + path,
                        {**headers, "Content-Type": "application/json"},
                        body if method == "GET" or body else b"",
                    )

                browser = None
                if bundle.browser:
                    browser = dict(out=args.out/"browser",reserve=reserve_native,version=versions["ingress"], api=api,
                        key=key,session=session,revision=args.revision,web=json.loads((args.fixture.parent/"qualified-web.json").read_bytes()),
                        accounting=dict(capture=private_file(args.fixture, "native-receipt.json"),
                                        captureDigest=proof["nativeReceiptDigest"]))
                exercise(owner, cloud, bundle, send, read, versions, key, args.pairs, report, save,browser)
                native_installation(account, args.revision, approved_native)
            except Exception as error:
                report["runFailure"] = str(error) if isinstance(error, Refused) else type(error).__name__
                raise
            finally:
                report["cleanup"] = cleanup_evidence(owner, cloud)
        failed = any(cell["status"] == "fail" for cell in report.get("boundaries", {}).values())
        report["status"] = "failed" if failed else "completed"
        return int(failed)
    except Exception as error:
        report.update(
            status="stopped",
            reason=str(error) if isinstance(error, Refused) else type(error).__name__,
        )
        return 1
    finally:
        save()


if __name__ == "__main__":
    raise SystemExit(main())
