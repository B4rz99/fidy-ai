"""Execute the fixed cohort actions through a private pipe and the ordinary closed provider."""
from contextlib import contextmanager
import json
import os
from pathlib import Path
import select
import subprocess
import time

from fixture import digest, prepare, uuid, write
from hosted import HERE, ROOT, RECEIPT_PATH, private_file, verify_native_fixture


@contextmanager
def commands(revision, runtime="cohort-bridge.ts", exchange=None):
    env = {**os.environ, "FIDY_NATIVE_REVISION": revision}
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
        if member["outcome"] == "created":
            write(self.directory / "native-session.json", self.session(member))
        return member["outcome"], uuid(member["id"])

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

    def denial(self):
        if (self.directory / "native-session.json").exists():
            self.command("denied", **private_file(self.directory, "native-session.json"))
        else:
            self.command("refused")

    def renew(self):
        self.command("renew")


def collect_owned(owner, port):
    coords = owner.coordinates
    session = private_file(port.directory, "native-session.json")

    def call(method, path, body):
        time.sleep(.7)
        response = port.command("canonical", method=method, path=path, body=body, **session)
        if response["status"] // 100 != 2:
            raise ValueError("Canonical cohort operation returned HTTP " + str(response["status"]))
        return response["data"]

    port.guard("foreground")
    manifest = prepare(call, port.directory, coords["revision"], "performance-1")
    owner.offer_receipt()
    sealed = call("POST", RECEIPT_PATH, dict(resourcePrefix=coords["prefix"], nativeManifestDigest=digest(manifest)))
    write(port.directory / "native-receipt.json", sealed)
    result = verify_native_fixture(port.directory, revision=coords["revision"], resource_prefix=coords["prefix"])
    if port.marker_owner() != coords["prefix"]:
        raise ValueError("Receipt lacks its independently observed one-use marker")
    owner.save("receipt-verified")
    return result
