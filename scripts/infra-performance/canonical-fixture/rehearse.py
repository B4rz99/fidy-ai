"""Rehearse canonical capture, link, inspect, and recovery against a real native User store."""
import argparse
import json
import os
from pathlib import Path
import ssl
import subprocess
import sys
import tempfile
import time

from fixture import prepare, write

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent / "cells"))
from importlib.util import module_from_spec, spec_from_file_location
spec = spec_from_file_location("http_rehearsal", HERE.parent / "cells/rehearse.py")
http = module_from_spec(spec)
spec.loader.exec_module(http)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out", required=True, type=Path)
    args = parser.parse_args()
    dest = args.out.resolve()
    dest.mkdir(parents=True, exist_ok=False)
    root = http.reference.ROOT
    revision = subprocess.check_output(["git","rev-parse","HEAD"], cwd=root, text=True).strip()
    offered = []
    with tempfile.TemporaryDirectory() as temp:
        scratch = Path(temp)
        public, key = scratch / "tls.crt", scratch / "tls.key"
        subprocess.run(["openssl","req","-x509","-newkey","rsa:2048","-nodes","-days","1","-subj","/CN=127.0.0.1",
                        "-addext","subjectAltName=IP:127.0.0.1","-keyout",key,"-out",public], check=True,
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        env = {**os.environ, "TMPDIR":temp, "FIDY_REFERENCE":"1", "FIDY_ASSESSMENT":"canonical-empty",
               "PLAYWRIGHT_TLS_KEY":str(key), "PLAYWRIGHT_TLS_CERT":str(public)}
        with http.reference.serve(["bun","scripts/infra-performance/reference/native.ts"], root, env, scratch/"native.log") as proc:
            subject = http.LocalSubject(4173, ssl.create_default_context(cafile=str(public)))
            subject.prepare(proc)
            def call(method, path, body):
                if len(offered) >= 40:
                    raise ValueError("Rehearsal exhausted its finite request count")
                time.sleep(.65)
                status, _, data = subject.canonical(path, body, method)
                offered.append(dict(method=method, status=status, operation="source" if "attestations" in path else path.split("?")[0].split("/")[1]))
                write(dest / "attempts.json", offered)
                if not 200 <= status < 300:
                    raise ValueError(f"Canonical operation returned HTTP {status}")
                return json.loads(data)
            class LostCaptureReply(Exception):
                pass
            def interrupted(method, path, body):
                result = call(method, path, body)
                if method == "POST" and path == "/operations/atomic-batch":
                    raise LostCaptureReply()
                return result
            try:
                prepare(interrupted, dest/"fixture", revision, "performance-1")
            except LostCaptureReply:
                pass
            else:
                raise ValueError("The lost-reply control did not execute")
            result = prepare(call, dest/"fixture", revision, "performance-1")
            if len([row for row in offered if row["method"]=="POST"]) != 2:
                raise ValueError("Recovery repeated a capture or link mutation")
            previous = len(offered)
            if prepare(call, dest/"fixture", revision, "performance-1") != result or any(row["method"]=="POST" for row in offered[previous:]):
                raise ValueError("Resuming the fixture attempted another mutation")
            owner = subject.snapshot()
            if len(owner["capture"]) != 8 or len(owner["links"]) != 1:
                raise ValueError("Native fixture ownership counts differ")
            write(dest/"fixture"/"native-local-provenance.json", dict(origin="disposable native workerd", **owner))
            status, _, _ = subject.canonical("/transactions/" + result["visible"] + "/source-attestations")
            if status != 404:
                raise ValueError("Reevaluate the mounted provenance contract")
            privacy = subject.json("/web/privacy/transactions", {"cursor":None}, "POST")
            if privacy["data"] != result["history"]["data"] or set(privacy) != {"reference","scope","data","presentation","categories","next"}:
                raise ValueError("Unexpected scope of the authenticated privacy response")
            write(dest/"report.json", dict(scope="native workerd synthetic WebSession", counts=result["counts"],
                                           initial=previous, resumed=len(offered)-previous, duplicateMutations=0, lostCaptureReplyReconciled=True, attestationStatus=status, privacyScope=privacy["scope"]))


if __name__ == "__main__":
    main()
