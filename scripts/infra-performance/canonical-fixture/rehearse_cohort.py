"""Interrupt the native collector after issuance, discard the controller, then recover against workerd."""
import argparse
from contextlib import closing, contextmanager
from email.message import Message
import json
import os
from pathlib import Path
import secrets
from shutil import copyfile
import sqlite3
import subprocess
from tempfile import TemporaryDirectory
import time

from cohort import Cohort
from cohort_runner import BrowserPort, collect_owned, commands
from fixture import digest, write
from hosted import ROOT
from protected_cohort import HostedPort, NATIVE_API

ACCOUNTING_PATH = "/internal/release-smoke?acceptance=transaction-accounting&cohort=performance&ordinal="


class LocalCustody:
    def __init__(self, path):
        self.path = path

    def read(self):
        if not self.path.exists():
            return None, None
        data = json.loads(self.path.read_bytes())
        return digest(data), data

    def replace(self, version, state):
        if self.read()[0] != version:
            raise ValueError("Private rehearsal custody changed")
        write(self.path, state)
        return digest(state)


class LocalPort(BrowserPort):
    def census(self):
        return self.runtime("census")

    def marker_owner(self):
        return self.runtime("marker")

    def guard(self, phase):
        if phase == "begin":
            return
        state = self.owner.state
        state.setdefault("foregroundRun", self.run)
        state.setdefault("foregroundUntil", int(time.time())+1200)
        if phase in ("cleanup", "finish"):
            state.update(cleanupRun=self.run, cleanupUntil=int(time.time())+900)
        self.owner.save(state["stage"])

    def renew(self):
        super().renew()
        if not self.runtime("tick"):
            raise ValueError("Closed background dispatch refused")

    def exchange(self, outgoing):
        def workerd(url, headers, body):
            reply = self.runtime("provider-request", body=dict(url=url, method=outgoing["method"], headers=headers,
                                  body=None if body is None else body.decode()))
            received = Message()
            for key, value in reply["headers"]:
                received[key] = value
            return reply["status"], received, reply["body"].encode()
        return HostedPort.exchange(self, outgoing, workerd)


@contextmanager
def controller(directory, coords, path):
    revision = coords["revision"]
    member = coords.get("fixtureMember", "performance-1")
    with commands(revision, "cohort-runtime.test-fixture.ts", member=member) as runtime, commands(
            revision, exchange=lambda req: port.exchange(req), member=member) as command:
        port = LocalPort(command, directory)
        port.runtime = runtime
        port.run = "disposable-workerd"
        port.owner = Cohort(LocalCustody(path), coords, port)
        yield port


def native_accounts(directory, physical, session, user):
    database, = directory.rglob(physical + ".sqlite")
    with TemporaryDirectory() as temporary:
        snapshot = Path(temporary) / "audit.sqlite"
        copyfile(database, snapshot)
        wal = Path(str(database) + "-wal")
        if wal.exists():
            copyfile(wal, str(snapshot) + "-wal")
        with closing(sqlite3.connect(snapshot)) as db:
            return session_accounts(db, session, user)


def session_accounts(db, session, user):
    audit = dict((operation+"."+outcome, count) for operation,outcome,count in db.execute(
            "SELECT operation,outcome,count(*) FROM audit_entries WHERE user_id=? AND session_id=? AND operation IS NOT NULL GROUP BY operation,outcome",
            (user,session["binding"])))
    units,receipts = db.execute("SELECT (SELECT coalesce(sum(units),0) FROM commercial_allowance_consumptions WHERE user_id=?1 AND allowance='canonical_call'),(SELECT count(*) FROM canonical_request_receipts WHERE user_id=?1)",(user,)).fetchone()
    return {**audit,"canonicalUnits":units,"receipts":receipts}


def prove_accounting_witness(port, directory, proof, revision, survivor):
    capture = json.loads((directory / "native-receipt.json").read_bytes())
    session = json.loads((directory / "native-session.json").read_bytes())
    member = capture["member"]
    ordinal = member[-1]
    headers = {
        "cookie": session["cookie"],
        "fidy-session-binding": session["binding"],
        "content-type": "application/json",
        "origin": "https://storage-web-acceptance.fidyapp.com",
    }

    def witness(phase, *, envelope=capture, offered=ordinal, auth=headers, signed=True):
        request = dict(url=NATIVE_API + ACCOUNTING_PATH + offered, headers=auth, method="POST",
                       body=json.dumps(dict(phase=phase, capture=envelope)))
        return port.runtime("accounting-witness" if signed else "provider-request", body=request)

    forged = {**capture, "signature": "0" * 128}
    other_member = "1" if ordinal == "2" else "2"
    wrong_binding = {**headers, "fidy-session-binding": "00000000-0000-4000-8000-000000000000"}
    foreign_cookie = {**headers, "cookie": survivor["cookie"]}
    for denied in (witness("before", envelope=forged), witness("before", offered=other_member),
                   witness("invalid"), witness("before", auth=wrong_binding),
                   witness("before", auth=foreign_cookie), witness("before", signed=False)):
        if 200 <= denied["status"] < 300:
            raise ValueError("Unauthorized accounting witness disclosed data")

    before = witness("before")
    read = port.runtime("canonical", method="GET", path="/transactions?limit=25", **session)
    after = witness("after")
    if [before["status"], read["status"], after["status"]] != [200, 200, 200]:
        raise ValueError(f"Accounting witness or intervening history failed: {before['status']}, {read['status']}, {after['status']}")
    expected = ["fidy-2259-native-accounting-v1", revision, member, proof["resourcePrefix"],
                proof["nativeReceiptDigest"], capture["sessionBindingSha256"]]
    statements = []
    for response, phase in ((before, "before"), (after, "after")):
        value = json.loads(response["body"])
        statement = value["statement"]
        if set(value) != {"statement", "signature"} or statement[:7] != [*expected, phase] or len(statement) != 10:
            raise ValueError("Unexpected accounting statement coordinates or fields")
        statements.append(value)
    first, last = (value["statement"] for value in statements)
    before_counts = {(operation, outcome): count for operation, outcome, count in first[7]}
    after_counts = {(operation, outcome): count for operation, outcome, count in last[7]}
    read_key = ("transactions.listTransactions", "success")
    before_counts[read_key] = before_counts.get(read_key, 0) + 1
    if before_counts != after_counts or first[8:] != [0, 0] or last[8:] != [0, 0]:
        raise ValueError("Accounting witness did not observe the history Audit without introducing state")
    if port.marker_owner() != proof["resourcePrefix"]:
        raise ValueError("Accounting witness changed the one-use fence")
    verifier = """
const ecdsa = { name: "ECDSA", namedCurve: "P-256" };
const key = await crypto.subtle.importKey("spki", Buffer.from(process.env.FIDY_NATIVE_FIXTURE_PUBLIC_KEY, "hex"), ecdsa, false, ["verify"]);
for (const { statement, signature } of await Bun.stdin.json()) {
  if (!await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, key, Buffer.from(signature, "hex"), new TextEncoder().encode(JSON.stringify(statement)))) {
    throw Error("Accounting witness signature mismatch");
  }
}
"""
    subprocess.run(["bun", "-e", verifier], input=json.dumps(statements), text=True, check=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out", required=True, type=Path)
    parser.add_argument("--d1",type=Path)
    parser.add_argument("--calibration",type=Path)
    parser.add_argument("--second-member", action="store_true")
    args = parser.parse_args()
    if bool(args.d1) != bool(args.calibration):
        parser.error("The paired browser requires both frozen checkouts")
    out = args.out.resolve()
    os.umask(0o077)
    out.mkdir(parents=True, exist_ok=False)
    directory = out / "fixture"
    directory.mkdir(mode=0o700)
    revision = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=ROOT, text=True).strip()
    coords = dict(revision=revision, prefix="fidy-2259-" + secrets.token_hex(6))
    if args.second_member:
        coords["fixtureMember"] = "performance-2"
    os.environ["SMOKE_PROOF"] = secrets.token_hex(32)
    os.environ["FIDY_REHEARSAL_STATE"] = str(out / "workerd")
    key = "const k=await crypto.subtle.generateKey({name:'ECDSA',namedCurve:'P-256'},true,['sign','verify']);process.stdout.write(JSON.stringify([Buffer.from(await crypto.subtle.exportKey('pkcs8',k.privateKey)).toString('hex'),Buffer.from(await crypto.subtle.exportKey('spki',k.publicKey)).toString('hex')]))"
    os.environ["TEST_FIXTURE_PRIVATE_KEY"], os.environ["FIDY_NATIVE_FIXTURE_PUBLIC_KEY"] = json.loads(
        subprocess.check_output(["bun", "-e", key], text=True))
    path = out / "custody.json"
    with controller(directory, coords, path) as port:
        survivor = None
        if args.d1:
            port.runtime("seed-survivors")
        else:
            survivor, _ = port.runtime("mount-original-sessions")
        port.owner.enroll()
        proof = collect_owned(port.owner, port, browser=bool(args.d1))
        if survivor is not None:
            prove_accounting_witness(port, directory, proof, revision, survivor)
    if args.d1:
        import sys
        sys.path.insert(0,str(ROOT/"scripts/infra-performance/cells"))
        from rehearse_browser import paired
        session=json.loads((directory/"native-session.json").read_bytes())
        user=json.loads((directory/"manifest.json").read_bytes())["workspace"]["profile"]["data"]["id"]
        physical=json.loads(path.read_bytes())["physical"]
        before=native_accounts(out/"workerd",physical,session,user)
        try:
            paired(out,proof,session,revision,coords["prefix"],args.d1,args.calibration)
            after=native_accounts(out/"workerd",physical,session,user)
            delta={k:after.get(k,0)-before.get(k,0) for k in after.keys()|before.keys()}
            write(out/"native-window-audit.json",delta)
            expected={"transactions.listTransactions.success":33,"transactions.updateTransaction.success":1,"transactions.updateTransaction.validation_failed":1,"canonicalUnits":0,"receipts":0}
            if any(delta.get(k,0)!=v for k,v in expected.items()):
                raise ValueError("Original native Session Audit or commercial accounting differs")
        finally:
            with controller(directory, coords, path) as port:
                port.owner.cleanup()
    with controller(directory, coords, path) as port:
        resumed = port.owner
        resumed.cleanup()
        write(out / "summary.json", dict(scope="disposable workerd", nativeRevision=revision, member=proof["member"],
              receiptDigest=proof["nativeReceiptDigest"], stage=resumed.state["stage"],
              survivors=2, freshProcess=True, protectedRelay=True,
              foregroundRequests=resumed.state["foregroundRequests"], cleanupRequests=resumed.state["cleanupRequests"], originalSessionDenied=True,
              physicalState=resumed.state["physicalState"],
              oneUseFenceRetained=resumed.state["receiptMarkerRetained"]))


if __name__ == "__main__":
    main()
