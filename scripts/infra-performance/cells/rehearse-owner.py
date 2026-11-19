"""Interrupt the actual controller against native workerd and resume disposal from fresh custody state."""
import argparse
import json
import os
from pathlib import Path
import socket
import subprocess
import tempfile
import urllib.request

from budget import Refused, today
from owner import AccountExperiment, MaterializedBundle, exercise, prepare_inventory, teardown
from owner_bundle import sha
from owner_transport import ROOT, HERE, transport
from test_owner import ConditionalObject


class LostRunner(BaseException):
    pass


class Sandbox:
    def __init__(self, path, scratch):
        self.prefix = 'fidy-2259-aabbccddeeff'
        self.storage = scratch/'inventory'
        self.storage.mkdir()
        self.process = subprocess.Popen(['bun',str(HERE/'probe.mjs'),str(path),'owner-pipe'],stdin=subprocess.PIPE,
                    stdout=subprocess.PIPE,text=True,env={'HOME':str(scratch),'TMPDIR':str(scratch),'PATH':os.environ['PATH']},cwd=ROOT)
        self.entry = self.receive()

    def receive(self):
        for line in self.process.stdout:
            if line.startswith("FIDY_OWNER_PIPE "):
                return json.loads(line.removeprefix("FIDY_OWNER_PIPE "))
        raise RuntimeError("Workerd owner transport closed")

    def command(self, payload):
        self.process.stdin.write(json.dumps(payload)+'\n')
        self.process.stdin.flush()
        return self.receive()

    def identity(self, role):
        path = self.storage/role
        return path.read_text() if path.exists() else None

    def create(self, role):
        (self.storage/role).write_text('local-'+role)

    def remove(self, role, identity):
        assert identity == self.identity(role)
        if role == 'core':
            self.process.stdin.write('{"action":"close"}\n')
            self.process.stdin.flush()
            assert self.process.wait(timeout=30) == 0
        (self.storage/role).unlink()

    def namespaces(self):
        return ['local-coordinator'] if self.identity('core') else []

    def query(self, _, statements):
        return self.command(dict(action='query', batch=statements))

    def marker(self):
        return 'recovery/generation'

    def request(self, method, path, *args, **kwargs):
        assert path == self.marker()
        return self.command(dict(action='put-marker' if method == 'PUT' else 'get-marker')).encode()

    def send(self, method, path, headers, body):
        url = 'http://127.0.0.1:'+str(self.entry['port'])+path
        req = urllib.request.Request(url,method=method,headers={**headers,'Content-Type':'application/json'},data=body)
        with transport.open(req,timeout=30) as reply:
            return reply.status,reply.headers,reply.read(1_000_000)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--bundle',type=Path,required=True)
    parser.add_argument('--out',type=Path,required=True)
    args=parser.parse_args()
    path = args.bundle.resolve()
    evidence = dict(scope='credential-free workerd',attempts=[],hostedObservations=[])
    with tempfile.TemporaryDirectory() as tmp:
        scratch = Path(tmp)
        # Rehearsal metadata is confined to scratch. The hosted entry demands the genuine sealed receipt.
        local = scratch/'bundle'
        local.mkdir()
        manifest = json.loads((path/'manifest.json').read_bytes())
        for name in ('expected','snapshot-proof','disclosure'):
            manifest['sha256'][name] = sha((path/(name+'.json')).read_bytes())
        manifest['contractDigest'] = 'a'*64
        for name in ('plan','probe','expected','limits','snapshot-proof','disclosure'):
            (local/(name+'.json')).symlink_to(path/(name+'.json'))
        for name in ('metered-core','bounded-ingress'):
            (local/(name+'.mjs')).symlink_to(path/(name+'.mjs'))
        wire = json.dumps(manifest).encode()
        (local/'manifest.json').write_bytes(wire)
        proof = json.loads((path/'plan.json').read_bytes())['canonicalTransactionFixture']
        bundle = MaterializedBundle(local,sha(wire),proof,1)
        cloud = Sandbox(path,scratch)
        try:
            store = ConditionalObject()
            account = 'a'*32
            owner = AccountExperiment(store,account)
            owner.begin(cloud.prefix,dict(_tag='Allowed',maximumRowsRead=bundle.estimate['rowsRead'],
                            maximumRowsWritten=bundle.estimate['rowsWritten']),today())
            prepare_inventory(owner,cloud)
            def lost():
                if evidence['attempts']:
                    assert evidence['attempts'][0]['ok']
                    raise LostRunner()
            try:
                exercise(owner,cloud,bundle,cloud.send,None,{'ingress':cloud.entry['version']},cloud.entry['key'],1,evidence,lost)
            except LostRunner:
                pass
            restored = AccountExperiment(store,account)
            assert restored.active['pending']['name'] == 'observe-history'
            try:
                restored.batch('repeat',bundle.http['GET /transactions?limit=25'],lambda:None)
                raise AssertionError('Unresolved native batch was replayed')
            except Refused:
                pass
            # The original controller and pending request have stopped. Advance only the fault clock.
            from unittest.mock import patch
            with patch('owner.time.time',return_value=restored.active['deadline']+91):
                evidence['cleanup'] = teardown(restored,cloud,resumed=True)
                assert teardown(AccountExperiment(store,account),cloud,resumed=True) == evidence['cleanup']
            assert not list(cloud.storage.iterdir())
            try:
                with socket.create_connection(('127.0.0.1',int(cloud.entry['port'])),timeout=2):
                    raise AssertionError('Disposed graph still answers')
            except ConnectionRefusedError:
                evidence['socketClosed'] = True
        finally:
            if cloud.process.poll() is None:
                cloud.process.terminate()
                cloud.process.wait(timeout=30)
    assert not scratch.exists()
    args.out.parent.mkdir(parents=True,exist_ok=True)
    args.out.write_text(json.dumps(evidence,indent=2))


if __name__ == '__main__':
    main()
