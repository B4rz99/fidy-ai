"""Require both original financial Sessions to remain usable across a fresh native code release."""
import argparse
import os
from pathlib import Path
import secrets
import subprocess
import tempfile

from cohort_runner import commands
from fixture import digest, write
from hosted import ROOT

BASELINE = "8dd3b0d47d655868c1ab4f16b6145a06d99bd721"


def observations(runtime, sessions):
    result = []
    for session in sessions:
        reply = runtime("canonical", method="GET", path="/transactions?limit=25",
                        cookie=session["cookie"], binding=session["fidy-session-binding"])
        result.append(dict(status=reply["status"], bodyDigest=digest(reply["data"])))
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out", required=True, type=Path)
    out = parser.parse_args().out
    os.umask(0o077)
    out.mkdir(parents=True, exist_ok=False)
    source = ROOT / "closed-baseline"
    baseline = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=source, text=True).strip()
    candidate = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=ROOT, text=True).strip()
    if baseline != BASELINE or candidate == baseline:
        raise ValueError("Two exact distinct release revisions are required")
    os.environ["SMOKE_PROOF"] = secrets.token_hex(32)
    os.environ["TEST_FIXTURE_PRIVATE_KEY"] = subprocess.check_output(
        ["bun", "-e", "const key=await crypto.subtle.generateKey({name:'ECDSA',namedCurve:'P-256'},true,['sign','verify']);process.stdout.write(Buffer.from(await crypto.subtle.exportKey('pkcs8',key.privateKey)).toString('hex'))"],
        text=True)
    with tempfile.TemporaryDirectory() as storage:
        os.environ["FIDY_REHEARSAL_STATE"] = storage
        os.environ["FIDY_REHEARSAL_BASELINE"] = "true"
        with commands(baseline, "cohort-runtime.test-fixture.ts") as runtime:
            sessions = runtime("mount-original-sessions")
            original_ids = runtime("survivors")
            original = observations(runtime, sessions)
            inventory = runtime("census")
            if len(sessions) != 2 or any(row["status"] != 200 for row in original):
                raise ValueError("Original deployed-source workerd controls unavailable")
        os.environ["FIDY_REHEARSAL_BASELINE"] = "false"
        os.environ["FIDY_NATIVE_FIXTURE_PROVIDER_REVISION"] = baseline
        with commands(candidate, "cohort-runtime.test-fixture.ts") as runtime:
            advanced = observations(runtime, sessions)
            resumed_identity = runtime("survivors") == original_ids
            same_inventory = inventory == runtime("census")
        os.environ["FIDY_REHEARSAL_BASELINE"] = "true"
        with commands(baseline, "cohort-runtime.test-fixture.ts") as runtime:
            restored = observations(runtime, sessions)
            restored_inventory = inventory == runtime("census")
        passed = advanced == restored == original and same_inventory and restored_inventory and resumed_identity
        write(out/"summary.json", dict(baseline=baseline, candidate=candidate,
              scope="disposable workerd; original two bound Sessions", original=original,
              advanced=advanced, restored=restored, freshLoginsMatched=resumed_identity, samePhysicalInventory=same_inventory,
              restoredPhysicalInventory=restored_inventory, passed=passed))
        if not passed:
            raise ValueError("The original bound financial reads did not survive the release")


if __name__ == "__main__":
    main()
