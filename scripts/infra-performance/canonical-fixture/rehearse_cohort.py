"""Interrupt the native collector after issuance, discard the controller, then recover against workerd."""
import argparse
from contextlib import contextmanager
from email.message import Message
import json
import os
from pathlib import Path
import secrets
import subprocess
import time

from cohort import Cohort
from cohort_runner import BrowserPort, collect_owned, commands
from fixture import digest, write
from hosted import ROOT, private_file
from protected_cohort import HostedPort
from native_smoke import native_delta, reserve_smoke, route_counts


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


def rehearse_native_smoke(directory, path, coords, proof, out):
    manifest = private_file(directory, "manifest.json")
    expected = {key: manifest[key] for key in ("history", "workspace")}
    allowed = route_counts(expected, refreshes=1)
    with controller(directory, coords, path) as port:
        deadline, maximum_preflights = reserve_smoke(port.owner, port, proof, allowed)
    revision = coords["revision"]
    config = dict(
        deadline=int(min(deadline, time.time() + 180) * 1000),
        maximumPreflights=maximum_preflights, expected=expected, allowed=allowed,
        native=dict(revision=revision, session=private_file(directory, "native-session.json"), web=dict(
            api="https://storage-acceptance.fidyapp.com", browser="https://storage-web-acceptance.fidyapp.com",
            revision=revision, contractDigest="a" * 64,
        )),
    )
    result = subprocess.run(
        ["bun", "scripts/infra-performance/hosted-browser/native-smoke.test-fixture.ts"],
        cwd=ROOT, timeout=180, text=True, stdout=subprocess.PIPE, check=True,
        env={**os.environ, "FIDY_DIAGNOSTIC_DIR": str(out)},
        input=json.dumps(dict(config=config, capture=private_file(directory, "native-receipt.json"),
                              captureDigest=proof["nativeReceiptDigest"])),
    )
    observed = json.loads(result.stdout)
    verified = native_delta(observed["before"], observed["after"], refreshes=1)
    write(out / "native-correctness.json", dict(scope="native-only disposable workerd",
          **observed["smoke"], nativeAccounting=verified))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out", required=True, type=Path)
    parser.add_argument("--second-member", action="store_true")
    parser.add_argument("--native-smoke", action="store_true")
    args = parser.parse_args()
    if args.native_smoke and not args.second_member:
        parser.error("Native smoke needs the second member")
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
        port.runtime("seed-survivors")
        port.owner.enroll()
        proof = collect_owned(port.owner, port, browser=args.native_smoke)
    if args.native_smoke:
        try:
            rehearse_native_smoke(directory, path, coords, proof, out)
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
