"""Require both original financial Sessions to remain usable across a fresh native code release."""
import argparse
import json
import os
from pathlib import Path
import secrets
import subprocess
import tempfile
import time

from cohort_runner import BrowserPort, commands
from fixture import digest, facts, prepare, write
from hosted import RECEIPT_PATH, ROOT, verify_native_fixture

BASELINE = "8dd3b0d47d655868c1ab4f16b6145a06d99bd721"


def observations(runtime, sessions):
    result = []
    for session in sessions:
        reply = runtime("canonical", method="GET", path="/transactions?limit=25",
                        cookie=session["cookie"], binding=session["fidy-session-binding"])
        result.append(dict(status=reply["status"], bodyDigest=digest(reply["data"])))
    return result


def qualify_fallback(revision, out, storage):
    directory = out / "fixture"
    directory.mkdir(mode=0o700)
    prefix = "fidy-2259-" + secrets.token_hex(6)
    os.environ["FIDY_REHEARSAL_STATE"] = str(Path(storage) / "fallback")
    os.environ["FIDY_REHEARSAL_BASELINE"] = "false"
    os.environ["FIDY_REHEARSAL_FALLBACK"] = "true"
    with commands(revision, "cohort-runtime.test-fixture.ts") as runtime:
        if runtime("recovery-probe") != {"status":200,"ingress":True,"core":True}:
            raise ValueError("The two dormant artifacts did not identify themselves")
        session = BrowserPort.session(runtime("register"))
        write(directory/"native-session.json", session)
        def call(method, path, body):
            time.sleep(.7)
            result = runtime("canonical", method=method, path=path, body=body, **session)
            if result["status"] // 100 != 2:
                raise ValueError(f"Ordinary financial request failed in the recovery artifact (HTTP {result['status']})")
            return result["data"]
        manifest = prepare(call, directory, revision, "performance-1")
        offering = dict(resourcePrefix=prefix, nativeManifestDigest=digest(manifest))
        denied = runtime("canonical", method="POST", path=RECEIPT_PATH, body=offering, **session)
        if denied["status"] != 404 or runtime("marker") is not None:
            raise ValueError("The recovery artifact issued a receipt for a fully authorized fixture")
    os.environ["FIDY_REHEARSAL_FALLBACK"] = "false"
    with commands(revision, "cohort-runtime.test-fixture.ts") as runtime:
        if runtime("recovery-probe") != {"status":200,"ingress":False,"core":False}:
            raise ValueError("The active application claimed the recovery artifacts")
        response = runtime("canonical", method="POST", path=RECEIPT_PATH, body=offering, **session)
        if response["status"] != 200 or runtime("marker") != prefix:
            raise ValueError("The active artifact failed to issue the original fixture")
        write(directory/"native-receipt.json",response["data"])
        proof = verify_native_fixture(directory, revision=revision, resource_prefix=prefix)
    os.environ["FIDY_REHEARSAL_FALLBACK"] = "true"
    with commands(revision, "cohort-runtime.test-fixture.ts") as runtime:
        history = runtime("canonical", method="GET", path="/transactions?limit=25", **session)
        if history["status"] != 200 or history["data"] != manifest["history"]:
            raise ValueError("Reverting to the recovery artifact failed the signed fixture read")
    return {"fallbackReceiptStatus":denied["status"], "activeReceiptStatus":response["status"],
            "restoredHistoryDigest":digest(history["data"]), "receiptDigest":proof["nativeReceiptDigest"]}


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
    os.environ["TEST_FIXTURE_PRIVATE_KEY"], os.environ["FIDY_NATIVE_FIXTURE_PUBLIC_KEY"] = json.loads(subprocess.check_output(
        ["bun", "-e", "const key=await crypto.subtle.generateKey({name:'ECDSA',namedCurve:'P-256'},true,['sign','verify']);process.stdout.write(JSON.stringify([Buffer.from(await crypto.subtle.exportKey('pkcs8',key.privateKey)).toString('hex'),Buffer.from(await crypto.subtle.exportKey('spki',key.publicKey)).toString('hex')]))"],
        text=True))
    with tempfile.TemporaryDirectory() as storage:
        os.environ["FIDY_REHEARSAL_STATE"] = storage
        os.environ["FIDY_REHEARSAL_BASELINE"] = "true"
        with commands(baseline, "cohort-runtime.test-fixture.ts") as runtime:
            sessions = runtime("mount-original-sessions")
            for index, headers in enumerate(sessions):
                call = {"calls":[{"callId":f"99000000-0000-4000-8000-{index:012d}",
                        "operation":"transactions.createTransaction","input":{"payload":facts(index+2)}}]}
                capture = runtime("canonical", method="POST", path="/operations/atomic-batch", body=call,
                                  cookie=headers["cookie"],binding=headers["fidy-session-binding"])
                if capture["status"] // 100 != 2:
                    raise ValueError("Original release could not capture the preexisting financial data")
            original_ids = runtime("survivors")
            original = observations(runtime, sessions)
            inventory = runtime("census")
            if len(sessions) != 2 or len({row["bodyDigest"] for row in original}) != 2 or any(row["status"] != 200 for row in original):
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
        fallback = qualify_fallback(candidate, out, storage)
        write(out/"summary.json", dict(fallback=fallback, baseline=baseline, candidate=candidate,
              scope="disposable workerd; original two bound Sessions", original=original,
              advanced=advanced, restored=restored, freshLoginsMatched=resumed_identity, samePhysicalInventory=same_inventory,
              restoredPhysicalInventory=restored_inventory, passed=passed))
        if not passed:
            raise ValueError("The original bound financial reads did not survive the release")


if __name__ == "__main__":
    main()
