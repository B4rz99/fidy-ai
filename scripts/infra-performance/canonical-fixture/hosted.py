"""Capture the exact performance-1 Transactions and obtain sealed evidence from their real owner."""
import argparse
from contextlib import contextmanager
import hashlib
import json
import os
from pathlib import Path
import re
import secrets
import subprocess
import time

from fixture import digest, prepare, serialized, validate_originals, write

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[2]
RECEIPT_PATH = "/internal/release-smoke?acceptance=transaction-fixture&cohort=performance&ordinal=1"


def private_file(directory, name):
    path = directory / name
    if directory.is_symlink() or directory.stat().st_mode & 0o077 or path.is_symlink() or path.stat().st_mode & 0o077:
        raise ValueError("Native fixture evidence requires private runner storage")
    return json.loads(path.read_bytes())


def read_native_session(directory):
    return private_file(Path(directory), "native-session.json")


def verified_provenance(directory, *, revision, resource_prefix):
    directory = Path(directory)
    manifest = private_file(directory, "manifest.json")
    sealed = private_file(directory, "native-receipt.json")
    session = read_native_session(directory)
    if (not re.fullmatch(r"[0-9a-f]{40}", revision) or not re.fullmatch(r"fidy-2259-[0-9a-f]{12}", resource_prefix)
            or manifest["revision"] != revision or manifest["member"] != "performance-1"
            or sealed["nativeRevision"] != revision or sealed["resourcePrefix"] != resource_prefix
            or sealed["member"] != "performance-1" or sealed["nativeManifestDigest"] != digest(manifest)
            or sealed["sessionBindingSha256"] != hashlib.sha256(session["binding"].encode()).hexdigest()):
        raise ValueError("Native receipt coordinates differ from the approved experiment")
    validate_originals(manifest["originals"])
    check = subprocess.run(["bun", str(HERE / "bridge.ts"), "verify"], cwd=ROOT,
                           env={**os.environ, "FIDY_NATIVE_REVISION": revision},
                           input=json.dumps(sealed), capture_output=True, text=True, timeout=20)
    if check.returncode != 0:
        raise ValueError("Native owner signature or encryption failed verification")
    evidence = json.loads(check.stdout)
    if len(evidence["capture"])!=8 or len(evidence["links"])!=1:
        raise ValueError("Native owner receipt has the wrong fixture cardinality")
    return evidence, dict(nativeRevision=revision, member="performance-1", resourcePrefix=resource_prefix,
                          nativeReceiptDigest=digest(sealed), nativeManifestDigest=digest(manifest))


def verify_native_fixture(directory, *, revision, resource_prefix):
    return verified_provenance(directory, revision=revision, resource_prefix=resource_prefix)[1]


@contextmanager
def bridge(mode, revision, session):
    env = {**os.environ, "FIDY_NATIVE_REVISION": revision}
    if session.exists():
        env["FIDY_BOUND_SESSION_FILE"] = str(session.resolve())
    else:
        env.pop("FIDY_BOUND_SESSION_FILE",None)
    with subprocess.Popen(["bun",str(HERE/"bridge.ts"),mode], cwd=ROOT, env=env, stdin=subprocess.PIPE,
                          stdout=subprocess.PIPE, text=True, bufsize=1) as child:
        try:
            first = child.stdout.readline()
            if not first:
                raise ValueError("Closed native provider registration failed")
            auth=json.loads(first)
            if set(auth)!={"cookie","binding"} or not auth["cookie"].startswith("__Host-fidy_session="):
                raise ValueError("Missing bound native Session")
            write(session,auth)
            count=0
            def call(method,path,body,control=""):
                nonlocal count
                count+=1
                if count>45:
                    raise ValueError("Closed native request limit reached")
                child.stdin.write(json.dumps(dict(method=method,path=path,body=body,control=control))+"\n")
                child.stdin.flush()
                response=child.stdout.readline()
                if not response:
                    raise ValueError("Closed native transport interrupted")
                return json.loads(response)
            yield call
        finally:
            child.stdin.close()
            try:
                child.wait(timeout=20)
            except subprocess.TimeoutExpired:
                child.kill()


def collect(mode, revision, prefix, out):
    directory=out/"fixture"
    directory.mkdir(mode=0o700, exist_ok=True)
    # Serialize Session creation and receipt issuance separately from the canonical mutation journal.
    with serialized(out/"owner"):
        marker=out/"owner"/"attempt.json"
        state=json.loads(marker.read_text()) if marker.is_file() else {"revision":revision,"resourcePrefix":prefix,"member":"performance-1"}
        if state["revision"]!=revision or state["resourcePrefix"]!=prefix or state["member"]!="performance-1":
            raise ValueError("Another synthetic fixture owns this journal")
        if (directory/"native-receipt.json").is_file():
            return verify_native_fixture(directory,revision=revision,resource_prefix=prefix)
        if "receipt" in state or ("signup" in state and not (directory/"native-session.json").is_file()):
            raise ValueError("A prior protected offering is unresolved")
        state["signup"]="offered"; write(marker,state)
        with bridge(mode,revision,directory/"native-session.json") as send:
            def canonical(method,path,data):
                time.sleep(.7)
                reply=send(method,path,data)
                if reply["status"]//100 != 2:
                    raise ValueError("Canonical fixture operation returned HTTP "+str(reply["status"]))
                return reply["data"]
            report=prepare(canonical,directory,revision,"performance-1")
            request={"resourcePrefix":prefix,"nativeManifestDigest":digest(report)}
            if mode=="rehearse":
                for failure in ("unsigned","wrong-binding","foreign-session"):
                    refused=send("POST",RECEIPT_PATH,request,failure)
                    if refused["status"]//100==2:
                        raise ValueError("Foreign or unauthorized fixture receipt was issued")
            state["receipt"]="offered"; write(marker,state)
            result=send("POST",RECEIPT_PATH,request)
            if result["status"]!=200:
                raise ValueError("Native provenance owner returned HTTP "+str(result["status"]))
            write(directory/"native-receipt.json",result["data"])
            if mode=="rehearse" and send("POST",RECEIPT_PATH,request)["status"]//100==2:
                raise ValueError("Native owner reissued a single-use receipt")
        bindings=verify_native_fixture(directory,revision=revision,resource_prefix=prefix)
        state["receipt"]="verified";write(marker,state)
        return bindings


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument("mode",choices=("rehearse","hosted"))
    parser.add_argument("--out",type=Path,required=True)
    parser.add_argument("--native-revision")
    parser.add_argument("--resource-prefix")
    args=parser.parse_args()
    os.umask(0o077)
    args.out.mkdir(mode=0o700,parents=True,exist_ok=True)
    if args.mode=="rehearse":
        revision=subprocess.check_output(["git","rev-parse","HEAD"],cwd=ROOT,text=True).strip()
        prefix="fidy-2259-"+secrets.token_hex(6)
        os.environ["SMOKE_PROOF"]=secrets.token_hex(32)
        create="const k=await crypto.subtle.generateKey({name:'ECDSA',namedCurve:'P-256'},true,['sign','verify']);process.stdout.write(JSON.stringify([Buffer.from(await crypto.subtle.exportKey('pkcs8',k.privateKey)).toString('hex'),Buffer.from(await crypto.subtle.exportKey('spki',k.publicKey)).toString('hex')]))"
        pair=json.loads(subprocess.check_output(["bun","-e",create],text=True))
        os.environ["TEST_FIXTURE_PRIVATE_KEY"],os.environ["FIDY_NATIVE_FIXTURE_PUBLIC_KEY"]=pair
    else:
        revision,prefix=args.native_revision or "",args.resource_prefix or ""
        if not os.environ.get("FIDY_NATIVE_FIXTURE_PUBLIC_KEY") or not os.environ.get("SMOKE_PROOF"):
            raise ValueError("Closed native receipt authority is unavailable")
    if not re.fullmatch(r"[a-f0-9]{40}",revision) or not re.fullmatch(r"fidy-2259-[a-f0-9]{12}",prefix):
        raise ValueError("Missing exact native revision or allocated comparison prefix")
    verified=collect(args.mode,revision,prefix,args.out)
    write(args.out/"summary.json",{"scope":args.mode,"nativeRevision":revision,"member":"performance-1",
        "originals":8,"effective":7,"sourceAttestations":8,"linkedPairs":1,"verified":True,
        "nativeReceiptDigest":verified["nativeReceiptDigest"],"nativeManifestDigest":verified["nativeManifestDigest"]})


if __name__=="__main__":
    main()
