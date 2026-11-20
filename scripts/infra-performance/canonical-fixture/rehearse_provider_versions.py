"""Retain the original provider, two financial Users and their public logins across owner versions."""
from collections import Counter
import os
from pathlib import Path
import secrets
import shutil
import subprocess
import tempfile

from cohort_runner import commands
from fixture import facts, write
from hosted import ROOT
from rehearse_release_controls import BASELINE, observations

REPAIR = "1072b915a879bc94c20ae400bad72d945ed8a341"
RUNTIME = "cohort-runtime.test-fixture.ts"


def main():
    original = ROOT / "closed-baseline"
    if subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=original, text=True).strip() != BASELINE:
        raise ValueError("Wrong original application revision")
    if subprocess.check_output(["git", "rev-parse","HEAD"],cwd=ROOT/"closed-candidate",text=True).strip() != REPAIR:
        raise ValueError("Wrong repaired application revision")
    os.environ["SMOKE_PROOF"] = secrets.token_hex(32)
    os.environ["TEST_FIXTURE_PRIVATE_KEY"] = subprocess.check_output(
        ["bun", "-e", "const k=await crypto.subtle.generateKey({name:'ECDSA',namedCurve:'P-256'},true,['sign','verify']); process.stdout.write(Buffer.from(await crypto.subtle.exportKey('pkcs8',k.privateKey)).toString('hex'))"],
        text=True)
    os.environ["FIDY_NATIVE_FIXTURE_PROVIDER_REVISION"] = BASELINE
    with tempfile.TemporaryDirectory() as temp:
        original_state = Path(temp)/"original"
        os.environ.update(FIDY_REHEARSAL_STATE=str(original_state), FIDY_REHEARSAL_BASELINE="true",
                          FIDY_REHEARSAL_SPLIT_OWNERS="old-old")
        with commands(BASELINE, RUNTIME) as runtime:
            sessions = runtime("mount-original-sessions")
            for index, session in enumerate(sessions):
                result = runtime("canonical", method="POST", path="/operations/atomic-batch",
                    body={"calls":[{"callId":f"99000000-0000-4000-8000-{index:012d}",
                    "operation":"transactions.createTransaction","input":{"payload":facts(index+2)}}]},
                    cookie=session["cookie"],binding=session["fidy-session-binding"])
                if result["status"] != 200:
                    raise ValueError("Original capture failed")
            expected = runtime("controls")
            histories = observations(runtime,sessions)
            if len(expected) != 2 or len({r["id"] for r in expected}) != 2 or len({r["bodyDigest"] for r in histories}) != 2:
                raise ValueError("Original financial controls were indistinguishable")
        os.environ["FIDY_REHEARSAL_BASELINE"]="false"
        outcomes = {}
        for placement in ("old-old", "old-new", "new-old", "new-new"):
            state = Path(temp)/placement
            shutil.copytree(original_state,state)
            trace = Path(temp)/f"{placement}.txt"
            os.environ.update(FIDY_REHEARSAL_STATE=str(state),FIDY_REHEARSAL_SPLIT_OWNERS=placement,
                              FIDY_REHEARSAL_SELECTOR_LOG=str(trace))
            with commands(REPAIR,RUNTIME) as runtime:
                mounted = observations(runtime,sessions) == histories
                matched = runtime("streamed-controls") == expected
                boundary = dict(Counter(trace.read_text().splitlines())) if trace.exists() else {}
                outcomes[placement] = dict(originalMountedHistories=mounted, retainedLoginAndHistories=matched,
                    selectorBoundary=boundary, selectedCore=boundary.get("FIDY_VERSION_BOUNDARY core complete selected")==2,
                    ordinaryDirectory=boundary.get("FIDY_VERSION_BOUNDARY directory complete ordinary")==2
                    and boundary.get("FIDY_VERSION_BOUNDARY directory inspect ordinary",0)>=2
                    and not any("directory" in name and "selected" in name for name in boundary))
            print(placement,outcomes[placement],flush=True)
        out = ROOT/"apps/server/test-results/provider-completion"
        out.mkdir(parents=True,exist_ok=True)
        write(out/"report.json",dict(baseline=BASELINE,candidate=REPAIR,candidateCoreSource=subprocess.check_output(["git","rev-parse","HEAD"],cwd=ROOT,text=True).strip(),users=len(expected),ownerOrder=["Directory","UserStore"],outcomes=outcomes))
        if not all(all(row.values()) for row in outcomes.values()):
            raise ValueError("Retained financial login or Worker-only version selection failed")


if __name__=="__main__":
    main()
