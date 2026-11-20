"""Execute the fixed cohort actions through a private pipe and the ordinary closed provider."""
from contextlib import contextmanager
import json
import os
from pathlib import Path
import select
import subprocess
import time

from fixture import digest, prepare, uuid, write
from cohort import identity
from hosted import HERE, ROOT, RECEIPT_PATHS, private_file, verify_native_fixture


@contextmanager
def commands(revision, runtime="cohort-bridge.ts", exchange=None, *, member="performance-1"):
    env = {key: value for key, value in os.environ.items() if key in (
        "PATH", "HOME", "TMPDIR", "SystemRoot", "SMOKE_PROOF", "TEST_FIXTURE_PRIVATE_KEY", "FIDY_REHEARSAL_STATE",
        "FIDY_REHEARSAL_BASELINE", "FIDY_REHEARSAL_FALLBACK", "FIDY_NATIVE_FIXTURE_PROVIDER_REVISION")}
    env["FIDY_NATIVE_REVISION"] = revision
    env["FIDY_BOUND_FIXTURE_MEMBER"] = member
    with subprocess.Popen(["bun", str(HERE / runtime)], cwd=ROOT, env=env, stdin=subprocess.PIPE,
                          stdout=subprocess.PIPE, text=True, bufsize=1) as child:
        def push(payload):
            child.stdin.write(json.dumps(payload) + "\n")
            child.stdin.flush()

        def command(action, **fields):
            push(dict(action=action, **fields))
            deadline = time.monotonic() + (720 if action == "refused" else 120)
            for _ in range(200):
                if not select.select([child.stdout], [], [], max(0, deadline-time.monotonic()))[0]:
                    raise ValueError("Native cohort transport deadline expired")
                line = child.stdout.readline(1_000_001)
                if not line or len(line) > 1_000_000:
                    raise ValueError("Native cohort transport interrupted")
                if not line.startswith("FIDY_PRIVATE_RESPONSE "):
                    continue
                data = json.loads(line[len("FIDY_PRIVATE_RESPONSE "):])
                if isinstance(data, dict) and set(data) == {"exchange"}:
                    if exchange is None:
                        raise ValueError("Offline runtime requested an external transport")
                    push(exchange(data["exchange"]))
                else:
                    return data
            raise ValueError("Native cohort command exceeded its request bound")
        try:
            yield command
        finally:
            child.stdin.close()
            try:
                child.wait(timeout=10)
            except subprocess.TimeoutExpired:
                child.kill()


class BrowserPort:
    def __init__(self, command, directory):
        self.command = command
        self.directory = directory
        self.cleanup_session = None

    def survivors(self):
        return [uuid(user) for user in self.command("survivors")]

    def before_signup(self):
        self.command("before-signup")

    @staticmethod
    def session(member):
        headers = member["headers"]
        cookie, binding = headers["cookie"], headers["fidy-session-binding"]
        if not cookie.startswith("__Host-fidy_session=") or not binding:
            raise ValueError("Invalid protected browser session")
        return dict(cookie=cookie, binding=binding)

    def register(self):
        member = self.command("register")
        session = self.session(member)
        if member["outcome"] == "created":
            write(self.directory / "native-session.json", session)
        return member["outcome"], uuid(member["id"]), digest(session)

    def login(self):
        return self.remember(self.command("login"))

    def recover_login(self):
        member = self.command("cleanup-login")
        return None if member is None else self.remember(member)

    def remember(self, member):
        if member["outcome"] != "approved":
            raise ValueError("An existing performance User is required for cleanup")
        user = uuid(member["id"])
        self.cleanup_session = user, self.session(member)
        return user

    def erase(self, user):
        if self.cleanup_session is None or self.cleanup_session[0] != user:
            raise ValueError("Cleanup belongs to another Session")
        self.command("erase", **self.cleanup_session[1])

    def denial(self, original_digest):
        if original_digest and (self.directory / "native-session.json").exists():
            previous = private_file(self.directory, "native-session.json")
            if digest(previous) != original_digest:
                raise ValueError("Private session differs from the original enrollment")
            self.command("denied", **previous)
        else:
            self.command("refused")

    def renew(self):
        self.command("renew")


def collect_owned(owner, port, *, browser=False):
    coords = owner.coordinates
    member = coords.get("fixtureMember", "performance-1")
    session = private_file(port.directory, "native-session.json")

    def call(method, path, body):
        time.sleep(.7)
        response = port.command("canonical", method=method, path=path, body=body, **session)
        if response["status"] // 100 != 2:
            raise ValueError("Canonical cohort operation returned HTTP " + str(response["status"]))
        return response["data"]

    port.guard("foreground")
    if browser:
        owner.save("owned", workload="mounted-transactions-ordinary")
    manifest = prepare(call, port.directory, coords["revision"], member, browser_workspace=browser)
    if browser and (identity(manifest["workspace"]["profile"]["data"]["id"]) != owner.state["user"]
                    or manifest["workspace"]["review"]["data"]["pendingCount"] != 0):
        raise ValueError("Native original Session or enrolled workspace differs")
    owner.offer_receipt()
    sealed = call("POST", RECEIPT_PATHS[member], dict(resourcePrefix=coords["prefix"], nativeManifestDigest=digest(manifest)))
    write(port.directory / "native-receipt.json", sealed)
    result = verify_native_fixture(port.directory, revision=coords["revision"], resource_prefix=coords["prefix"],
                                   member=member)
    if port.marker_owner() != coords["prefix"]:
        raise ValueError("Receipt lacks its independently observed one-use marker")
    owner.save("receipt-verified", receiptDigest=result["nativeReceiptDigest"])
    return result
