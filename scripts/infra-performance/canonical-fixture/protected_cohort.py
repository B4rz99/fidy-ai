"""Protected native fixture admission, collection and independent, cohort-only physical disposal."""
from datetime import datetime
import json
import os
import re
import sys
import time
from urllib.parse import parse_qs, urlsplit

from cohort import Cohort
from cohort_runner import BrowserPort, collect_owned, commands
from fixture import write
from hosted import HERE, RECEIPT_PATH
from installation import validate_candidate, validate_qualification
from qualified_release import artifact, serving_graph

sys.path.insert(0, str(HERE.parent / "cells"))
from owner_cloud import Cloud
from owner_state import CustodyObject
from owner_transport import NATIVE_API, cloudflare, fetch
# Select the existing native fleet meter ahead of the unrelated D1 pilot.
fleet_path = HERE.parent / "deployed-fleet"
sys.path.insert(0, str(fleet_path))
from native_budget import CLEANUP_READS, CLEANUP_WRITES, DAY, check, observe, recovery_reservation


def protected_runner():
    env = os.environ
    if not (env.get("GITHUB_ACTIONS") == "true" and env.get("GITHUB_REF_PROTECTED") == "true"
            and env.get("GITHUB_EVENT_NAME") == "workflow_dispatch" and env.get("NATIVE_STORAGE_ADMISSION") == "closed"
            and env.get("GITHUB_REF") == "refs/heads/trunk" and env.get("GITHUB_REPOSITORY") == "B4rz99/fidy-ai"
            and env.get("GITHUB_WORKFLOW_REF") == "B4rz99/fidy-ai/.github/workflows/native-transaction-cohort.yml@refs/heads/trunk"):
        raise ValueError("Closed protected native cohort dispatch required")


def checked_browser_origin(path, now):
    origin = json.loads(path.read_bytes())
    if (origin.get("colombianEgress") is not True
            or any(origin["origins"][name]["country"] != "CO" for name in ("api","browser"))
            or not 0 <= now - datetime.fromisoformat(origin["observedAt"].replace("Z","+00:00")).timestamp() <= 120):
        raise ValueError("Missing fresh Colombia egress from both actual browser hosts")


def admitted_route(method, url, body, stage, cleaning, browser=False):
    path = url.path + ("?" + url.query if url.query else "")
    if method == "GET":
        if path == "/ingestion/review-workspace?limit=0&status=pending":
            return browser and stage == "owned" and not cleaning
        if path in ("/user", "/web/session/binding", "/web/consent/authorization", "/transactions", "/transactions?limit=25"):
            return True
        if url.path == "/providers/google/callback":
            query = parse_qs(url.query)
            return set(query) == {"state", "code"} and all(len(value) == 1 for value in query.values())
        return not cleaning and bool(re.fullmatch("/transactions/[a-f0-9-]{36}", path))
    if path == "/web/providers/google/start":
        intent = json.loads(body)["intent"]
        return intent == "login" or (not cleaning and stage == "signup-offered" and intent == "signup")
    if path in ("/web/pairings", "/web/pairings/redeem", "/web/providers/google/status", "/web/providers/google/complete"):
        return True
    if cleaning:
        if path == "/web/privacy/erasure":
            return stage == "erasure-offered" and json.loads(body) == {"confirm": True}
        return path == "/internal/release-smoke?acceptance=work"
    return ((stage == "owned" and path in ("/operations/atomic-batch", "/transactions/link"))
            or (stage == "receipt-offered" and path == RECEIPT_PATH))


class HostedPort(BrowserPort):
    def __init__(self, command, directory, *, account, verify, store, marker, cloud):
        super().__init__(command, directory)
        self.account, self.verify, self.store, self.marker, self.cloud = account, verify, store, marker, cloud
        self.owner = None
        self.initial = None
        self.finished = None
        self.run = os.environ["GITHUB_RUN_ID"] + "/" + os.environ["GITHUB_RUN_ATTEMPT"]

    def marker_owner(self):
        return self.marker.read()[1]

    def guard(self, phase):
        self.verify()
        now = int(time.time())
        if phase == "begin":
            self.initial = observe(cloudflare, self.account)
            check(self.initial, self.initial, phase, now)
            return
        state = self.owner.state
        initial = state.get("usageBefore", self.initial)
        if not initial:
            raise ValueError("Native account reservation missing")
        if "foregroundUntil" not in state:
            state.update(usageBefore=initial, foregroundUntil=now+20*60, foregroundRun=self.run)
        cleaning = phase in ("cleanup", "finish")
        if cleaning and self.run != state["foregroundRun"] and now < state["foregroundUntil"] + 90:
            raise ValueError("Original cohort dispatch or its in-flight grace period is still active")
        if not cleaning and (self.run != state["foregroundRun"] or now >= state["foregroundUntil"]
                             or state.get("cleanupRun")):
            raise ValueError("Native foreground custody expired")
        if cleaning and state.get("cleanupRun", self.run) != self.run and now < state.get("cleanupUntil", 0):
            raise ValueError("Independent cleanup claim still active")
        current = observe(cloudflare, self.account)
        if cleaning and initial["sqlite"]["sampled"] // DAY != now // DAY:
            if "recoveryUsageBefore" not in state:
                state["recoveryUsageBefore"] = recovery_reservation(initial, current, now)
            initial = state["recoveryUsageBefore"]
        delta = check(initial, current, phase, now)
        if "recoveryUsageBefore" in state and (delta["reads"] > CLEANUP_READS or delta["writes"] > CLEANUP_WRITES):
            raise ValueError("Reserved recovery rows exhausted")
        if phase == "finish":
            # Work accepted by Cloudflare can be absent from the newest analytics group.
            finished = state.get("lastDispatch", now)
            for attempt in range(20):
                if min(current["sqlite"]["latest"], current["r2"]["latest"]) >= finished and all(current["sqlite"][k] > initial["sqlite"][k]
                                                                  for k in ("reads", "writes")):
                    break
                if attempt == 19:
                    raise ValueError("Native account counters have not covered cleanup")
                time.sleep(30)
                current = observe(cloudflare, self.account)
                check(initial, current, phase, int(time.time()))
            self.finished = current
        if cleaning:
            state.update(cleanupRun=self.run, cleanupUntil=int(time.time())+15*60)
        self.owner.save(state["stage"], lastUsage=current)

    def exchange(self, outgoing, transport=fetch):
        url = urlsplit(outgoing["url"])
        if url.scheme != "https" or url.netloc != urlsplit(NATIVE_API).netloc or url.fragment:
            raise ValueError("Foreign native cohort origin")
        method = outgoing["method"]
        body = outgoing["body"]
        if method not in ("GET", "POST") or (method == "GET" and body is not None):
            raise ValueError("Unexpected native cohort HTTP operation")
        state = self.owner.state
        now = int(time.time())
        clean = bool(state.get("cleanupRun"))
        if not admitted_route(method, url, body, state["stage"], clean, state.get("workload")=="mounted-transactions-ordinary"):
            raise ValueError("HTTP route is outside the current native custody phase")
        deadline = state.get("cleanupUntil" if clean else "foregroundUntil", 0)
        if now >= deadline or state.get("cleanupRun" if clean else "foregroundRun") != self.run:
            raise ValueError("Cohort HTTP dispatch lost its custody lease")
        key = "cleanupRequests" if clean else "foregroundRequests"
        if state.get(key,0) >= (180 if clean else 100):
            raise ValueError("Native cohort request ceiling reached")
        self.owner.save(state["stage"], **{key: state.get(key,0)+1}, lastDispatch=now)
        if int(time.time()) >= deadline:
            raise ValueError("Cohort HTTP lease expired before dispatch")
        status, headers, raw = transport(outgoing["url"], outgoing["headers"],
                                     None if method == "GET" else (body or "").encode())
        return dict(status=status, headers=list(headers.items()), body=raw.decode())

    def census(self):
        namespace = self.owner.coordinates["userNamespace"]
        root = "workers/durable_objects/namespaces/" + namespace + "/objects?"
        response = self.cloud.request("GET", root+"limit=100")
        rows = response["result"]
        info = response.get("result_info") or {}
        if (len(rows) >= 100 or info.get("cursor") or (info.get("cursors") or {}).get("after")
                or len(set(row["id"] for row in rows)) != len(rows)):
            raise ValueError("Physical User inventory exceeds the calibrated single-page bound")
        return {row["id"]:row["hasStoredData"] for row in rows}


def run(args):
    protected_runner()
    account, revision, prefix = os.environ["CLOUDFLARE_ACCOUNT_ID"], args.native_revision, args.resource_prefix
    if not re.fullmatch("[a-f0-9]{40}", revision or "") or not re.fullmatch("fidy-2259-[a-f0-9]{12}", prefix or ""):
        raise ValueError("Exact release and allocated cohort prefix required")
    versions = dict(core=args.core_version, ingress=args.ingress_version)
    key = os.environ["FIDY_NATIVE_FIXTURE_PUBLIC_KEY"]
    promotion, installed = artifact(revision, args.release_artifact, args.archive_sha256)

    def verify():
        actual = validate_candidate(cloudflare, account=account, revision=revision, versions=versions, public_key=key)
        validate_qualification(actual, promotion, installed)
        serving_graph(cloudflare, account, revision, installed)
        return actual

    if args.mode != "cleanup" and args.browser_workspace:
        # The protected workflow writes this from real Chromium before touching cohort custody.
        checked_browser_origin(args.out/"origin-before-enrollment.json",time.time())
    candidate = verify()
    os.environ["FIDY_NATIVE_FIXTURE_PROVIDER_REVISION"] = installed["retainedProvider"]["revision"]
    coords = dict(**candidate, account=account, prefix=prefix, archive=args.archive_sha256)
    cloud = Cloud(account,prefix)
    store = CustodyObject(account, cloud, native_revision=revision)
    marker = CustodyObject(account, cloud, native_revision=revision, receipt_marker=True)
    directory = args.out / "fixture"
    if args.out.is_symlink() or args.out.stat().st_mode & 0o077 or directory.is_symlink():
        raise ValueError("Native collection requires a private runner directory")
    directory.mkdir(mode=0o700, exist_ok=True)
    if directory.stat().st_mode & 0o077:
        raise ValueError("Native fixture directory is not private")
    with commands(revision, exchange=lambda req: port.exchange(req)) as command:
        port = HostedPort(command, directory, account=account, verify=verify, store=store, marker=marker, cloud=cloud)
        owner = Cohort(store, coords, port)
        port.owner = owner
        if args.mode == "cleanup":
            owner.cleanup()
            write(args.out/"cleanup.json", dict(scope="hosted native cohort", status=owner.state["stage"],
                  physicalState=owner.state.get("physicalState"), survivors=2,
                  retainedOneUseFence=owner.state.get("receiptMarkerRetained"),
                  usageBefore=owner.state.get("usageBefore"), final=owner.state.get("lastUsage"),
                  recoveryUsageBefore=owner.state.get("recoveryUsageBefore"),
                  originalDaySettled="recoveryUsageBefore" not in owner.state))
        else:
            owner.enroll()
            proof = collect_owned(owner, port, browser=args.browser_workspace)
            if args.browser_workspace:
                write(args.out/"qualified-web.json", installed["website"][0])
            verify()
            write(args.out/"summary.json", dict(scope="hosted native fixture", originals=8,effective=7,**proof))


def comparable_native_reads(account, candidate, proof, pairs, *, browser=False):
    """Reserve each timed read before signing or starting either measured HTTP clock."""
    protected_runner()
    prefix, revision = proof["resourcePrefix"], proof["nativeRevision"]
    cloud = Cloud(account, prefix)
    store = CustodyObject(account, cloud, native_revision=revision)
    version, state = store.read()
    run = os.environ["GITHUB_RUN_ID"] + "/" + os.environ["GITHUB_RUN_ATTEMPT"]
    coords = state["coordinates"] if state else {}
    if (not state or state["stage"] != "receipt-verified" or state.get("foregroundRun") != run
            or state.get("cleanupRun") or coords.get("prefix") != prefix or coords.get("account") != account
            or any(coords.get(k) != v for k,v in candidate.items())
            or state.get("receiptDigest") != proof["nativeReceiptDigest"] or state.get("comparisonOffered") is not None
            or (state.get("workload")=="mounted-transactions-ordinary") != browser
            or (browser and pairs != 30) or pairs not in (1,30)):
        raise ValueError("Comparison does not own this protected native receipt")
    reserved = 0
    def reserve():
        nonlocal version, reserved
        now = int(time.time())
        if now >= state["foregroundUntil"] or reserved >= (1 if browser else pairs):
            raise ValueError("Native comparison allowance expired")
        current = observe(cloudflare, account)
        check(state["usageBefore"], current, "foreground", now)
        reserved += 1
        state.update(comparisonOffered=reserved, lastDispatch=now, lastUsage=current)
        if browser:
            # This one durable claim fences the entire finite window, including unresolved mutations.
            # The runner rejects excess route counts and cannot resume an interrupted window.
            state["browserReservation"] = dict(refreshes=30, correction=1, staleBatch=1,
                authenticatedRequests=67, maximumPreflights=67, admission="one-use")
        version = store.replace(version,state)
        if time.time() >= state["foregroundUntil"]:
            raise ValueError("Native comparison lease expired before dispatch")
        return state["foregroundUntil"]
    return reserve
