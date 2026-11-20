"""Interrupt the actual controller against native workerd and resume disposal from fresh custody state."""

import argparse
import fcntl
import json
import os
from pathlib import Path
import signal
import socket
import subprocess
import tempfile
import urllib.request

from budget import Refused, today
from owner import AccountExperiment, MaterializedBundle, exercise, prepare_inventory, cleanup_evidence
from owner_bundle import sha
from owner_transport import ROOT, HERE, transport


class RunnerCustody:
    """File-backed conditional object for two distinct credential-free runner processes."""

    def __init__(self, directory):
        self.path = directory / "custody.json"

    def read(self):
        if not self.path.exists():
            return None, None
        wire = self.path.read_bytes()
        return sha(wire), json.loads(wire)

    def replace(self, version, value):
        with self.path.with_suffix(".lock").open("a") as lock:
            fcntl.flock(lock, fcntl.LOCK_EX)
            if self.read()[0] != version:
                raise Refused("custody_version_conflict")
            wire = json.dumps(value).encode()
            temporary = self.path.with_suffix(".tmp")
            temporary.write_bytes(wire)
            temporary.replace(self.path)
            return sha(wire)


class Sandbox:
    def __init__(self, path, scratch):
        self.prefix = "fidy-2259-aabbccddeeff"
        self.storage = scratch / "inventory"
        self.storage.mkdir()
        read_fd, write_fd = os.pipe()
        with os.fdopen(write_fd, "wb") as control:
            self.process = subprocess.Popen(
                ["bun", str(HERE / "probe.mjs"), str(path), "owner-pipe"],
                stdin=subprocess.PIPE, stdout=subprocess.DEVNULL, text=True,
                pass_fds=(control.fileno(),),
                env={"HOME": str(scratch), "TMPDIR": str(scratch), "PATH": os.environ["PATH"],
                     "FIDY_OWNER_REPLY_FD": str(control.fileno())},
                cwd=ROOT,
            )
        self.replies = os.fdopen(read_fd)
        self.entry = self.receive()

    def receive(self):
        line = self.replies.readline()
        if not line:
            raise RuntimeError("Workerd owner transport closed")
        return json.loads(line)

    def command(self, payload):
        self.process.stdin.write(json.dumps(payload) + "\n")
        self.process.stdin.flush()
        return self.receive()

    def identity(self, role):
        path = self.storage / role
        return path.read_text() if path.exists() else None

    def create(self, role):
        (self.storage / role).write_text("local-" + role)
        return "local-" + role

    def remove(self, role, identity):
        assert identity == self.identity(role)
        if role == "core":
            self.process.stdin.write('{"action":"close"}\n')
            self.process.stdin.flush()
        (self.storage / role).unlink()

    def expose(self, role, enabled):
        assert role in ("ingress", "core") and not enabled

    def verify_absent(self, inventory, namespace_ids):
        assert not self.namespaces(namespace_ids) and not any(self.identity(r) for r in inventory)

    def namespaces(self, recorded=()):
        return ["local-coordinator"] if self.identity("core") else []

    def query(self, _, statements):
        return self.command(dict(action="query", batch=statements))

    def marker(self):
        return "recovery/generation"

    def request(self, method, path, *args, **kwargs):
        assert path == self.marker()
        return self.command(dict(action="put-marker" if method == "PUT" else "get-marker")).encode()

    def send(self, method, path, headers, body):
        url = "http://127.0.0.1:" + str(self.entry["port"]) + path
        req = urllib.request.Request(
            url, method=method, headers={**headers, "Content-Type": "application/json"}, data=body
        )
        with transport.open(req, timeout=30) as reply:
            return reply.status, reply.headers, reply.read(1_000_000)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--bundle", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()
    path = args.bundle.resolve()
    evidence = dict(scope="credential-free workerd", attempts=[], hostedObservations=[])
    with tempfile.TemporaryDirectory() as tmp:
        scratch = Path(tmp)
        local = scratch / "bundle"
        local.mkdir()
        manifest = json.loads((path / "manifest.json").read_bytes())
        for name in ("expected", "snapshot-proof", "disclosure"):
            manifest["sha256"][name] = sha((path / (name + ".json")).read_bytes())
        manifest["contractDigest"] = "a" * 64
        for name in ("plan", "probe", "expected", "limits", "snapshot-proof", "disclosure"):
            (local / (name + ".json")).symlink_to(path / (name + ".json"))
        for name in ("metered-core", "bounded-ingress"):
            (local / (name + ".mjs")).symlink_to(path / (name + ".mjs"))
        wire = json.dumps(manifest).encode()
        (local / "manifest.json").write_bytes(wire)
        proof = json.loads((path / "plan.json").read_bytes())["canonicalTransactionFixture"]
        bundle = MaterializedBundle(local, sha(wire), proof, 1)
        cloud = Sandbox(path, scratch)
        try:
            store = RunnerCustody(scratch)
            account = "a" * 32
            child = os.fork()
            if child == 0:
                try:
                    owner = AccountExperiment(store, account)
                    owner.begin(cloud.prefix, dict(_tag="Allowed", maximumRowsRead=bundle.estimate["rowsRead"],
                                maximumRowsWritten=bundle.estimate["rowsWritten"]), today())
                    prepare_inventory(owner, cloud)
                    def lost():
                        assert evidence["attempts"][0]["ok"]
                        assert "scheduledMs" not in evidence["attempts"][0] and "delayMs" not in evidence["attempts"][0]
                        (scratch / "observed.json").write_text(json.dumps(evidence))
                        os.kill(os.getpid(), signal.SIGKILL)
                    exercise(owner, cloud, bundle, cloud.send, None, {"ingress": cloud.entry["version"]},
                             cloud.entry["key"], 1, evidence, lost)
                except BaseException:
                    import traceback
                    traceback.print_exc()
                os._exit(1)
            _, wait_status = os.waitpid(child, 0)
            assert os.WIFSIGNALED(wait_status) and os.WTERMSIG(wait_status) == signal.SIGKILL
            evidence = json.loads((scratch / "observed.json").read_bytes())
            evidence["lostControllerSignal"] = "SIGKILL"
            recovery = os.fork()
            if recovery == 0:
                try:
                    restored = AccountExperiment(store, account)
                    assert restored.active["pending"]["name"] == "observe-history"
                    try:
                        restored.batch("repeat", bundle.http["GET /transactions?limit=25"], lambda: None)
                        raise AssertionError("Unresolved native batch was replayed")
                    except Refused:
                        pass
                    from unittest.mock import patch

                    with patch("owner.time.time", return_value=restored.active["deadline"] + 91):
                        evidence["cleanup"] = cleanup_evidence(restored, cloud, resumed=True)
                        assert (
                            cleanup_evidence(AccountExperiment(store, account), cloud, resumed=True)
                            == evidence["cleanup"]
                        )
                    (scratch / "recovered.json").write_text(json.dumps(evidence))
                    os._exit(0)
                except BaseException:
                    import traceback
                    traceback.print_exc()
                os._exit(1)
            _, recovery_status = os.waitpid(recovery, 0)
            assert os.waitstatus_to_exitcode(recovery_status) == 0
            assert cloud.process.wait(timeout=30) == 0
            evidence = json.loads((scratch / "recovered.json").read_bytes())
            assert not list(cloud.storage.iterdir())
            try:
                with socket.create_connection(("127.0.0.1", int(cloud.entry["port"])), timeout=2):
                    raise AssertionError("Disposed graph still answers")
            except ConnectionRefusedError:
                evidence["socketClosed"] = True
        finally:
            if cloud.process.poll() is None:
                cloud.process.terminate()
                cloud.process.wait(timeout=30)
    assert not scratch.exists()
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(evidence, indent=2))


if __name__ == "__main__":
    main()
