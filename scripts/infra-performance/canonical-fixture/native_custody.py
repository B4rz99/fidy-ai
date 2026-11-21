"""Read the native installation and keep conditional custody of its disposable User."""
import base64
import hashlib
import hmac
import json
import os
from pathlib import Path
import re
import subprocess
import tempfile
import time
import urllib.error
import urllib.request


class Refused(ValueError):
    pass


NATIVE_API = "https://storage-acceptance.fidyapp.com"


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args):
        return None


transport = urllib.request.build_opener(NoRedirect(), urllib.request.ProxyHandler({}))


def fetch(url, headers, body=None):
    req = urllib.request.Request(url, headers=headers, data=body)
    try:
        response = transport.open(req, timeout=30)
    except urllib.error.HTTPError as error:
        response = error
    with response:
        result = response.read(1_000_001)
        if len(result) > 1_000_000:
            raise ValueError("Response exceeds the native fixture bound")
        return response.status, response.headers, result


def cloudflare(path, body=None):
    status, _, raw = fetch(
        "https://api.cloudflare.com/client/v4/" + path,
        {
            "Authorization": "Bearer " + os.environ["CLOUDFLARE_API_TOKEN"],
            "Content-Type": "application/json",
        },
        None if body is None else json.dumps(body).encode(),
    )
    if status != 200:
        raise Refused("Cloudflare identity or usage unavailable")
    data = json.loads(raw)
    if body is not None:
        if data.get("errors"):
            raise Refused("Cloudflare account analytics unavailable")
        return data["data"]
    if data.get("success") is not True:
        raise Refused("Cloudflare did not confirm resource identity")
    return data["result"]



class Cloud:
    def __init__(self, account):
        if not re.fullmatch("[a-f0-9]{32}", account):
            raise Refused("invalid_resource_scope")
        self.root = "https://api.cloudflare.com/client/v4/accounts/" + account + "/"
        self.auth = os.environ["CLOUDFLARE_API_TOKEN"]

    def request(self, method, path):
        if method != "GET":
            raise Refused("native_inventory_requires_read")
        request = urllib.request.Request(self.root + path, headers={"Authorization": "Bearer " + self.auth})
        try:
            response = transport.open(request, timeout=45)
        except urllib.error.HTTPError as error:
            raise Refused("cloud_control_" + str(error.code)) from None
        with response:
            content = response.read(16_000_001)
        if len(content) > 16_000_000:
            raise Refused("control_response_too_large")
        wire = json.loads(content)
        if wire.get("success") is not True:
            raise Refused("unconfirmed_control_operation")
        return wire

    def result(self, method, path):
        return self.request(method, path)["result"]

BUCKET = "fidy-native-release-smoke"
LIFETIME = 20 * 60


def custody_credentials(account, key, parent_id, token, *, read_only=False):
    if not re.fullmatch("[a-f0-9]{32}", parent_id) or not token:
        raise Refused("invalid_parent_credential")
    def encoded(value):
        raw = json.dumps(value, separators=(",", ":")).encode()
        return base64.urlsafe_b64encode(raw).rstrip(b"=")
    now = int(time.time())
    claims = dict(sub=account, iss=parent_id, aud=f"{account}.r2.cloudflarestorage.com", iat=now,
                  exp=now+2*LIFETIME, bucket=BUCKET, actions=["GetObject"] if read_only else ["GetObject", "PutObject"],
                  paths=dict(prefixPaths=[], objectPaths=[key]))
    unsigned = encoded(dict(alg="HS256", typ="JWT")) + b"." + encoded(claims)
    parent_secret = hashlib.sha256(token.encode()).hexdigest().encode()
    signature = hmac.digest(parent_secret, unsigned, "sha256")
    signed = unsigned + b"." + base64.urlsafe_b64encode(signature).rstrip(b"=")
    return dict(AWS_ACCESS_KEY_ID=parent_id, AWS_SECRET_ACCESS_KEY=hashlib.sha256(signed).hexdigest(),
                AWS_SESSION_TOKEN=base64.b64encode(b"jwt/"+signed).decode())


class CustodyObject:
    def __init__(self, account, cloud, *, native_revision, receipt_marker=False, member="performance-1",
                 read_only=False):
        if not re.fullmatch("[a-f0-9]{32}", account):
            raise Refused("missing_account_binding")
        if member not in ("performance-1", "performance-2"):
            raise Refused("invalid_native_fixture_member")
        if not re.fullmatch("[0-9a-f]{40}", native_revision):
            raise Refused("invalid_native_custody_revision")
        self.key = (f"_release-smoke/{native_revision}/acceptance/transactions/{member}" if receipt_marker
                    else f"protected-storage/account/{account}/{member}/{native_revision}.json")
        self.receipt_marker = receipt_marker
        self.read_only = receipt_marker or read_only
        self.command = [
            "aws",
            "--endpoint-url",
            f"https://{account}.r2.cloudflarestorage.com",
            "--region",
            "auto",
            "--no-cli-pager",
            "s3api",
        ]
        if (os.environ.get("GITHUB_ACTIONS") != "true" or os.environ.get("GITHUB_REF") != "refs/heads/trunk"
                or os.environ.get("GITHUB_REPOSITORY") != "B4rz99/fidy-ai"
                or os.environ.get("GITHUB_REF_PROTECTED") != "true"):
            raise Refused("protected_trunk_runner_required")
        token = cloud.result("GET", "tokens/verify")
        if token.get("status") != "active":
            raise Refused("inactive_account_credential")
        self.env = dict(PATH=os.environ["PATH"], AWS_MAX_ATTEMPTS="1", AWS_EC2_METADATA_DISABLED="true",
                        **custody_credentials(account, self.key, token["id"], cloud.auth, read_only=self.read_only))

    def call(self, operation, *args):
        return subprocess.run(
            [*self.command, operation, "--bucket", BUCKET, "--key", self.key, *args],
            capture_output=True,
            env=self.env,
            timeout=30,
        )

    def read(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp, "ledger")
            reply = self.call("get-object", str(path))
            if reply.returncode:
                if b"(NoSuchKey)" in reply.stderr:
                    return None, None
                raise Refused("account_ledger_unavailable")
            return json.loads(reply.stdout)["ETag"], (path.read_text() if self.receipt_marker else json.loads(path.read_text()))

    def replace(self, version, value):
        if self.read_only:
            raise Refused("one_use_marker_is_read_only")
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp, "ledger")
            path.write_text(json.dumps(value))
            condition = ["--if-match", version] if version else ["--if-none-match", "*"]
            reply = self.call("put-object", "--body", str(path), *condition)
            if reply.returncode:
                raise Refused("account_ledger_changed_or_unavailable")
            return json.loads(reply.stdout)["ETag"]
