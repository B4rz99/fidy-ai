"""Capture the exact performance-1 Transactions and obtain sealed evidence from their real owner."""
import argparse
from contextlib import contextmanager
import hashlib
import json
import os
from pathlib import Path
import re
import secrets
import select
import subprocess
import sys
import time

from fixture import digest, instant, prepare, serialized, validate_originals, write

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


def open_envelope(sealed, revision):
    check = subprocess.run(["bun", str(HERE / "bridge.ts"), "verify"], cwd=ROOT,
                           env={**os.environ, "FIDY_NATIVE_REVISION": revision},
                           input=json.dumps(sealed), capture_output=True, text=True, timeout=20)
    if check.returncode != 0:
        raise ValueError("Native owner signature or encryption failed verification")
    return json.loads(check.stdout)


def verify_signed_originals(originals, capture):
    validate_originals(originals)
    by_id = {item["transactionId"]: item for item in capture}
    if len(capture) != 8 or set(by_id) != {item["id"] for item in originals}:
        raise ValueError("Native owner signed different original identities")
    for original in originals:
        source = by_id[original["id"]]
        expected = {
            "amount": original["money"]["amount"], "currency": original["money"]["currency"],
            "direction": original["direction"], "counterparty": original["counterparty"],
            "categoryId": original["categoryId"], "occurred": instant(original["occurredAt"]),
            "createdAtMs": instant(original["createdAt"]), "revision": original["revision"],
            "notes": original.get("notes"),
        }
        if any(name not in source or source[name] != value for name, value in expected.items()):
            raise ValueError("Native owner facts differ for an original Transaction")


def verify_signed_views(manifest, links):
    originals = {row["id"]: row for row in manifest["originals"]}
    inspections = manifest["inspections"]
    if set(inspections) != set(originals) or len(links) != 1:
        raise ValueError("The exact eight original inspections and one signed link are required")
    link, = links
    pair = [link["first"], link["second"]]
    visible, suppressed = manifest["visible"], manifest["suppressed"]
    if (visible != link["visible"] or visible == suppressed or set(pair) != {visible, suppressed}
            or not set(pair) <= set(originals)):
        raise ValueError("Manifest visible or suppressed original differs from the signed link")
    ordered = sorted((row for row in originals.values() if row["id"] != suppressed),
                     key=lambda row: (instant(row["occurredAt"]), instant(row["createdAt"]), row["id"]),
                     reverse=True)
    if manifest["history"].get("data") != ordered or manifest["history"].get("next") != []:
        raise ValueError("Effective history differs from the signed original facts and link")
    for requested, response in inspections.items():
        linked = requested in pair
        expected = originals[visible if linked else requested]
        data = response["data"]
        presentation = {"kind": "independent"}
        reconciliation = {"kind": "independent"}
        sources = []
        if linked:
            presentation = ({"kind": "visible-member"} if requested == visible else
                            {"kind": "suppressed-member", "requestedId": requested})
            reconciliation = {"kind": "linked", "firstTransaction": originals[pair[0]],
                              "secondTransaction": originals[pair[1]]}
            sources = [{"transactionId": item, "kinds": ["manual"]} for item in pair]
        if data != {**expected, "presentation": presentation,
                    "reconciliation": reconciliation, "sources": sources}:
            raise ValueError("An inspection response differs from its signed original facts and link")


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
    evidence = open_envelope(sealed,revision)
    verify_signed_originals(manifest["originals"], evidence["capture"])
    verify_signed_views(manifest, evidence["links"])
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
    entry = "closed-runtime.test-fixture.ts" if mode=="rehearse" else "bridge.ts"
    with subprocess.Popen(["bun",str(HERE/entry),mode], cwd=ROOT, env=env, stdin=subprocess.PIPE,
                          stdout=subprocess.PIPE, text=True, bufsize=1) as child:
        try:
            def receive():
                for _ in range(1000):
                    if not select.select([child.stdout], [], [], 90)[0]:
                        raise ValueError("Closed native fixture transport deadline expired")
                    line=child.stdout.readline(1_000_001)
                    if not line: return ""
                    if len(line)>1_000_000: raise ValueError("Protected runner response too large")
                    if line.startswith("FIDY_PRIVATE_RESPONSE "): return line[len("FIDY_PRIVATE_RESPONSE "):]
                raise ValueError("Protected runner output exhausted")
            first = receive()
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
                response=receive()
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


def rehearse(revision, prefix, out):
    mode = "rehearse"
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
            if mode=="rehearse":
                absent=send("POST",RECEIPT_PATH,{"resourcePrefix":prefix,"nativeManifestDigest":"0"*64})
                if absent["status"]//100==2:
                    raise ValueError("An empty synthetic User obtained a provenance receipt")
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
            send("GET","/transactions?limit=25",None,"local-browser")
        bindings=verify_native_fixture(directory,revision=revision,resource_prefix=prefix)
        state["receipt"]="verified";write(marker,state)
        return bindings


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument("mode",choices=("rehearse","hosted","cleanup"))
    parser.add_argument("--out",type=Path,required=True)
    parser.add_argument("--native-revision")
    parser.add_argument("--resource-prefix")
    parser.add_argument("--core-version")
    parser.add_argument("--ingress-version")
    parser.add_argument("--release-artifact")
    parser.add_argument("--archive-sha256")
    args=parser.parse_args()
    os.umask(0o077)
    args.out.mkdir(mode=0o700,parents=True,exist_ok=True)
    if args.mode=="rehearse":
        revision=subprocess.check_output(["git","rev-parse","HEAD"],cwd=ROOT,text=True).strip()
        prefix=args.resource_prefix or ("fidy-2259-"+secrets.token_hex(6))
        os.environ["SMOKE_PROOF"]=secrets.token_hex(32)
        create="const k=await crypto.subtle.generateKey({name:'ECDSA',namedCurve:'P-256'},true,['sign','verify']);process.stdout.write(JSON.stringify([Buffer.from(await crypto.subtle.exportKey('pkcs8',k.privateKey)).toString('hex'),Buffer.from(await crypto.subtle.exportKey('spki',k.publicKey)).toString('hex')]))"
        pair=json.loads(subprocess.check_output(["bun","-e",create],text=True))
        os.environ["TEST_FIXTURE_PRIVATE_KEY"],os.environ["FIDY_NATIVE_FIXTURE_PUBLIC_KEY"]=pair
        write(args.out/"rehearsal-verifier.json", {name:os.environ[name] for name in ("SMOKE_PROOF","FIDY_NATIVE_FIXTURE_PUBLIC_KEY")})
    else:
        from protected_cohort import run
        return run(args)
    if not re.fullmatch(r"[a-f0-9]{40}",revision) or not re.fullmatch(r"fidy-2259-[a-f0-9]{12}",prefix):
        raise ValueError("Missing exact native revision or allocated comparison prefix")
    verified=rehearse(revision,prefix,args.out)
    if args.mode=="rehearse":
        envelope=private_file(args.out/"fixture","native-receipt.json")
        damaged={**envelope, "signature":("0" if envelope["signature"][0]!="0" else "1")+envelope["signature"][1:]}
        try:
            open_envelope(damaged,revision)
        except ValueError:
            pass
        else:
            raise ValueError("Modified owner signature was accepted")
        if rehearse(revision,prefix,args.out)!=verified:
            raise ValueError("Protected resume changed the signed fixture")
    write(args.out/"summary.json",{"scope":args.mode,"nativeRevision":revision,"member":"performance-1",
        "originals":8,"effective":7,"sourceAttestations":8,"linkedPairs":1,"verified":True,
        "nativeReceiptDigest":verified["nativeReceiptDigest"],"nativeManifestDigest":verified["nativeManifestDigest"]})


if __name__=="__main__":
    main()
