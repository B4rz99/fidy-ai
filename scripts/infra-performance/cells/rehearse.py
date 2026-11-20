"""Exercise the comparison through the pinned D1 and native DO ingress with real WebSessions."""
import argparse
from contextlib import ExitStack
import hashlib
import http.cookiejar
import json
import os
from pathlib import Path
import ssl
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request

from comparison import BOUNDARIES, FIXTURE, READS, boundaries, offers

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent / "reference"))
import run as reference


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args):
        return None


class LocalSubject:
    def __init__(self, port, tls):
        self.api = f"https://127.0.0.1:{port + 1}"
        self.origin = f"https://127.0.0.1:{port}"
        self.operator = f"http://127.0.0.1:{port + 2}"
        self.client = urllib.request.build_opener(NoRedirect(), urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()),
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


def write(path, value):
    path.write_text(json.dumps(value, indent=2) + "\n")


def survey_read(subject, path, *, meter):
    """Read one complete response. Counter observations surround only its authenticated request."""
    if meter:
        before = json.loads(subject.control("/browser-cost"))
    status, _, body = subject.canonical(path)
    row = dict(status=status, bytes=len(body), sha256=hashlib.sha256(body).hexdigest())
    if meter:
        after = json.loads(subject.control("/browser-cost"))
        keys = ("rowsRead", "rowsWritten")
        if any(type(observed.get(key)) is not int for observed in (before, after) for key in keys):
            raise ValueError("D1 row counters unavailable for cost survey")
        row["cost"] = {key: after[key] - before[key] for key in keys}
        if min(row["cost"].values()) < 0:
            raise ValueError("D1 row counters regressed during cost survey")
    return row


def survey_costs(subjects, dest):
    report = dict(scope="Local fixed-ID fixture; request cost and raw body digests only.",
                  requestsPerShape=2, paths=READS, attempts=[])
    write(dest, report)
    for order in [("d1", "do"), ("do", "d1")]:
        for operation, path in READS.items():
            started = time.monotonic()
            for variant in order:
                row = survey_read(subjects[variant], path, meter=variant == "d1")
                report["attempts"].append(dict(operation=operation, variant=variant, **row))
                write(dest, report)
            # One isolated request per variant per second permits admission between shapes.
            time.sleep(max(0, 1 - (time.monotonic() - started)))


def compare_fixture(root, baseline, dest, scratch):
    verify = {"d1": reference.revision(baseline, "d1"), "do": reference.revision(root, "do")}
    certificate = scratch / "tls.crt"
    key = scratch / "tls.key"
    subprocess.run(["openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=127.0.0.1",
                    "-addext", "subjectAltName=IP:127.0.0.1", "-keyout", key, "-out", certificate],
                   check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    tls = ssl.create_default_context(cafile=str(certificate))
    plan = dict(scope="loopback rehearsal", revisions=verify, fixture=FIXTURE, fixtureProfile="production",
                lifecycle="unobserved", origin="loopback", network="ordinary", pairs=2,
                operation="transactions.page", path=READS["transactions.page"], order=["d1", "do", "do", "d1"],
                boundaries=BOUNDARIES, warmup="Session establishment only", sampleFloor=30,
                minRatio=1.8, clock="client monotonic", offeredLoad="one isolated User")
    write(dest / "plan.json", plan)
    rows = []
    costs = []
    coverage = {}
    with ExitStack() as stack:
        subjects = {}
        for variant, path, entry in (("d1", baseline, "apps/server/cloudflare/browser-acceptance-preview.ts"),
                                     ("do", root, "scripts/infra-performance/reference/native.ts")):
            env = {**os.environ, "TMPDIR": str(scratch), "FIDY_REFERENCE": "1", "CLI_ACCEPTANCE_MODE": "cli",
                   "FIDY_ASSESSMENT": "production", "PLAYWRIGHT_TLS_KEY": str(key), "PLAYWRIGHT_TLS_CERT": str(certificate),
                   "BROWSER_COST_MEASUREMENT": "1"}
            log = scratch / f"{variant}.log"
            proc = stack.enter_context(reference.serve(["bun", entry], path, env, log))
            subject = LocalSubject(reference.WEB_PORT[variant], tls)
            try:
                subject.prepare(proc)
            except Exception:
                print(json.dumps({"variant": variant, **reference.failure_metadata(log)}), file=sys.stderr)
                raise
            seed = next(json.loads(line.removeprefix("ASSESSMENT_SEED ")) for line in log.read_text().splitlines()
                        if line.startswith("ASSESSMENT_SEED "))
            if any(seed.get(k) != v for k, v in FIXTURE.items()):
                raise ValueError("Fixture count mismatch")
            subjects[variant] = subject

        for index, variant in enumerate(plan["order"]):
            subject = subjects[variant]
            before = subject.snapshot()
            if variant == "d1":
                prior = json.loads(subject.control("/browser-cost"))
            row, = offers(lambda _, path: subject.canonical(path), variant, index // 2, 1, 1)
            rows.append(row)
            write(dest / "attempts.json", rows)
            if variant == "d1":
                cost = json.loads(subject.control("/browser-cost"))
                delta = {k: cost[k] - prior[k] for k in ("rowsRead", "rowsWritten")}
                if not all(type(v) is int and v > 0 for v in delta.values()):
                    raise ValueError("Authenticated D1 read is missing native counters")
                costs.append(delta)
            after = subject.snapshot()
            row["accountability"] = {key: after[key] - before[key] for key in before}
            if row["accountability"] != dict(reads=1, corrections=0, units=0, receipts=0):
                row["ok"] = False
            write(dest / "attempts.json", rows)
        survey_costs(subjects, dest / "read-shape-costs.json")
        for variant, subject in subjects.items():
            status, _, _ = subject.canonical("/transactions/81000000-0000-4000-8000-000000000002/source-attestations")
            coverage[variant] = {"sourceAttestationsHttpStatus": status}
    result = boundaries(rows, expected_pairs=2, users=1)
    write(dest / "report.json", dict(scope=plan["scope"], lifecycle="unobserved", boundaries=result, d1RequestCost=costs, coverage=coverage))
    if not all(row["ok"] and row.get("backendMs", 0) > 0 for row in rows) or result["httpMs"]["status"] == "fail":
        raise RuntimeError("Unequal or incomplete canonical read")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--d1", type=Path, required=True)
    args = parser.parse_args()
    destination = reference.ROOT / "apps/server/test-results/storage-http"
    destination.mkdir(parents=True, exist_ok=False)
    with tempfile.TemporaryDirectory() as temp:
        compare_fixture(reference.ROOT, args.d1.resolve(), destination, Path(temp))
