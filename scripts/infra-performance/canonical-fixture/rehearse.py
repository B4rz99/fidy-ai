"""Rehearse canonical capture, link, inspect, and recovery against a real native User store."""
import argparse
from contextlib import contextmanager
import http.cookiejar
import json
import os
from pathlib import Path
import signal
import ssl
import subprocess
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request

from fixture import prepare, write

ROOT = Path(__file__).resolve().parents[3]


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args):
        return None


class LocalSubject:
    def __init__(self, port, tls):
        self.api = f"https://127.0.0.1:{port + 1}"
        self.origin = f"https://127.0.0.1:{port}"
        self.operator = f"http://127.0.0.1:{port + 2}"
        self.jar = http.cookiejar.CookieJar()
        self.client = urllib.request.build_opener(NoRedirect(), urllib.request.HTTPCookieProcessor(self.jar),
                                                 urllib.request.HTTPSHandler(context=tls), urllib.request.ProxyHandler({}))
        self.binding = None

    def canonical(self, path, body=None, method="GET"):
        headers = {"Origin": self.origin, "Accept": "application/json"}
        if self.binding:
            headers["Fidy-Session-Binding"] = self.binding
        if body is not None:
            headers["Content-Type"] = "application/json"
        request = urllib.request.Request(self.api + path, method=method, headers=headers,
                                         data=None if body is None else json.dumps(body).encode())
        try:
            response = self.client.open(request, timeout=30)
        except urllib.error.HTTPError as error:
            response = error
        with response:
            return response.status, response.headers, response.read()

    def control(self, path, method="GET"):
        with urllib.request.urlopen(urllib.request.Request(self.operator + path, method=method), timeout=5) as reply:
            return reply.read()

    def json(self, *args, **kwargs):
        status, _, body = self.canonical(*args, **kwargs)
        if not 200 <= status < 300:
            raise RuntimeError(f"Session setup returned HTTP {status}")
        return json.loads(body) if body else None

    def prepare(self, process):
        deadline = time.monotonic() + 180
        method = "POST"
        while time.monotonic() < deadline:
            if process.poll() is not None:
                raise RuntimeError("Fixture process exited")
            try:
                state = json.loads(self.control("/assessment/prepare", method))["status"]
                method = "GET"
                if state == "ready":
                    break
                if state == "failed":
                    raise RuntimeError("Fixture initialization failed")
            except OSError:
                pass
            time.sleep(.25)
        else:
            raise TimeoutError("Fixture did not initialize")
        pairing = self.json("/web/pairings", method="POST")
        self.control("/approve?" + urllib.parse.urlencode({"code": pairing["publicCode"], "navigationDashboard": "true"}), "POST")
        self.json("/web/pairings/redeem", {"pairingId": pairing["pairingId"], "privateVerifier": pairing["privateVerifier"]}, "POST")
        self.binding = self.json("/web/session/binding")["binding"]
        if not self.binding:
            raise RuntimeError("Missing live Session binding")

    def snapshot(self):
        return json.loads(self.control("/assessment/accountability"))


@contextmanager
def serve(args, cwd, env, log):
    with log.open("ab") as out:
        proc = subprocess.Popen(
            args, cwd=cwd, env=env, start_new_session=True, stdout=out, stderr=out
        )
        try:
            yield proc
        finally:
            try:
                os.killpg(proc.pid, signal.SIGTERM)
            except ProcessLookupError:
                pass
            try:
                proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                os.killpg(proc.pid, signal.SIGKILL)
                proc.wait()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out", required=True, type=Path)
    args = parser.parse_args()
    dest = args.out.resolve()
    dest.mkdir(parents=True, exist_ok=False)
    root = ROOT
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
        with serve(["bun","scripts/infra-performance/reference/native.ts"], root, env, scratch/"native.log") as proc:
            subject = LocalSubject(4173, ssl.create_default_context(cafile=str(public)))
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
