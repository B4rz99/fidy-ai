"""Drive the same D1 setup, retained Sessions, Chromium turn order and post-window Audit in workerd."""
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time

from owner import AccountExperiment, exercise, prepare_inventory, cleanup_evidence
from owner_bundle import MaterializedBundle, sha
from owner_transport import HERE, ROOT
from budget import today

spec = importlib.util.spec_from_file_location("offline_owner",HERE/"rehearse-owner.py")
local = importlib.util.module_from_spec(spec)
spec.loader.exec_module(local)


def paired(out, proof, session, revision, prefix, baseline, calibration):
    bundle_path = (out/"package").resolve()
    env = {**os.environ,"FIDY_DIAGNOSTIC_DIR":str(out.resolve()),"FIDY_NATIVE_REVISION":revision}
    subprocess.run(["python3",str(HERE/"prepare.py"),"--d1",str(baseline),"--calibration",str(calibration),
        "--canonical-fixture",str((out/"fixture").resolve()),"--materialized","--browser-workspace","--out",str(bundle_path)],env=env,check=True)
    package = MaterializedBundle(bundle_path,sha((bundle_path/"manifest.json").read_bytes()),proof,30)
    evidence = dict(scope="credential-free paired workerd",attempts=[],maximum=package.estimate)
    def save():
        (out/"paired.json").write_text(json.dumps(evidence))
    with tempfile.TemporaryDirectory() as temporary:
        scratch=Path(temporary)
        cloud=local.Sandbox(bundle_path,scratch)
        owner=AccountExperiment(local.RunnerCustody(scratch),"a"*32)
        owner.begin(cloud.prefix, dict(_tag="Allowed",maximumRowsRead=package.estimate["rowsRead"], maximumRowsWritten=package.estimate["rowsWritten"]),today())
        try:
            prepare_inventory(owner,cloud)
            browser=dict(out=out/"paired",api="https://"+prefix+"-ingress.loopback.workers.dev",key=cloud.entry["key"],
                         version=cloud.entry["version"],revision=revision,session=session,
                         web=dict(revision=revision,contractDigest="a"*64,browser="https://storage-web-acceptance.fidyapp.com",api="https://storage-acceptance.fidyapp.com"),
                         reserve=lambda:int(time.time())+600,workerd={**{k:env[k] for k in
                            ("NATIVE_WEB_ASSETS","TEST_FIXTURE_PRIVATE_KEY","FIDY_REHEARSAL_STATE")},
                            "LOCAL_D1_PORT":str(cloud.entry["port"])})
            exercise(owner,cloud,package,cloud.send,None,{"ingress":cloud.entry["version"]},cloud.entry["key"],30,evidence,save,browser)
        finally:
            evidence["disposal"]=cleanup_evidence(owner,cloud)
            save()
            if cloud.process.poll() is None: cloud.process.kill()
