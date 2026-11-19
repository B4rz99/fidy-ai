"""One conditional R2 object serializes all protected D1 experiments on this account."""

import base64
import hashlib
import hmac
import json
import os
import re
import secrets
import subprocess
import tempfile
import time
from pathlib import Path

from budget import KEYS, Refused, counts, today

BUCKET = "fidy-native-release-smoke"
LIFETIME = 20 * 60


def custody_credentials(account, key, parent_id, token):
    if not re.fullmatch("[a-f0-9]{32}", parent_id) or not token:
        raise Refused("invalid_parent_credential")
    def encoded(value):
        raw = json.dumps(value, separators=(",", ":")).encode()
        return base64.urlsafe_b64encode(raw).rstrip(b"=")
    now = int(time.time())
    claims = dict(sub=account, iss=parent_id, aud=f"{account}.r2.cloudflarestorage.com", iat=now,
                  exp=now+2*LIFETIME, bucket=BUCKET, actions=["GetObject", "PutObject"],
                  paths=dict(prefixPaths=[], objectPaths=[key]))
    unsigned = encoded(dict(alg="HS256", typ="JWT")) + b"." + encoded(claims)
    parent_secret = hashlib.sha256(token.encode()).hexdigest().encode()
    signature = hmac.digest(parent_secret, unsigned, "sha256")
    signed = unsigned + b"." + base64.urlsafe_b64encode(signature).rstrip(b"=")
    return dict(AWS_ACCESS_KEY_ID=parent_id, AWS_SECRET_ACCESS_KEY=hashlib.sha256(signed).hexdigest(),
                AWS_SESSION_TOKEN=base64.b64encode(b"jwt/"+signed).decode())


class CustodyObject:
    def __init__(self, account, cloud):
        if not re.fullmatch("[a-f0-9]{32}", account):
            raise Refused("missing_account_binding")
        self.key = f"protected-storage/account/{account}/d1-ledger.json"
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
                        **custody_credentials(account, self.key, token["id"], cloud.auth))

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
            return json.loads(reply.stdout)["ETag"], json.loads(path.read_text())

    def replace(self, version, value):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp, "ledger")
            path.write_text(json.dumps(value))
            condition = ["--if-match", version] if version else ["--if-none-match", "*"]
            reply = self.call("put-object", "--body", str(path), *condition)
            if reply.returncode:
                raise Refused("account_ledger_changed_or_unavailable")
            return json.loads(reply.stdout)["ETag"]


class AccountExperiment:
    def __init__(self, store, account):
        self.store = store
        self.version, state = store.read()
        self.state = (
            state
            if state is not None
            else dict(account=account, active=None, charged={}, last=None)
        )
        if self.state["account"] != account:
            raise Refused("foreign_account_ledger")

    @property
    def active(self):
        return self.state["active"]

    def save(self):
        # Vary each representation even if a later transition restores an earlier logical state.
        self.state["transition"] = secrets.token_hex(16)
        self.version = self.store.replace(self.version, self.state)

    def prior(self, day):
        charged = self.state["charged"]
        return (
            counts(charged["spent"])
            if charged.get("day") == day
            else dict(rowsRead=0, rowsWritten=0)
        )

    def full_estimate(self, estimate, day):
        previous = self.prior(day)
        return counts({k: previous[k] + estimate[k] for k in KEYS})

    def begin(self, prefix, decision, day):
        last = self.state["last"]
        if (
            self.active is not None
            or (last and (last["pending"] is not None or last["prefix"] == prefix))
            or day != today()
            or decision.get("_tag") != "Allowed"
            or not re.fullmatch("fidy-2259-[0-9a-f]{12}", prefix)
        ):
            raise Refused("account_experiment_unavailable")
        previous = self.prior(day)
        limit = counts(
            dict(
                rowsRead=decision["maximumRowsRead"] - previous["rowsRead"],
                rowsWritten=decision["maximumRowsWritten"] - previous["rowsWritten"],
            )
        )
        self.state["active"] = dict(
            prefix=prefix,
            ownership="owned-" + secrets.token_hex(16),
            deadline=int(time.time()) + LIFETIME,
            day=day,
            limit=limit,
            spent=dict(rowsRead=0, rowsWritten=0),
            inventory={},
            pending=None,
            cleaning=False,
        )
        self.state["charged"] = dict(day=day, spent=previous)
        self.save()

    def available(self):
        run = self.active
        if (
            not run
            or run["cleaning"]
            or run["pending"] is not None
            or run["day"] != today()
            or int(time.time()) >= run["deadline"]
        ):
            raise Refused("account_experiment_fenced")
        return run

    def control(self, method, path, *, cleanup=False):
        run = self.active if cleanup else self.available()
        now = int(time.time())
        deadline = run.get("cleanupUntil", 0) if cleanup else run["deadline"]
        if now >= deadline or run["cleaning"] is not cleanup:
            raise Refused("control_custody_expired")
        if cleanup:
            run["cleanupUntil"] = now + 90
        run["controlDispatches"] = run.get("controlDispatches", 0) + 1
        run["control"] = dict(method=method, resource=path.split("?",1)[0], offered=now)
        self.save()
        if time.time() >= deadline:
            raise Refused("control_custody_expired")

    def batch(self, name, maximum, operation):
        run, maximum = self.available(), counts(maximum)
        if any(run["spent"][k] + maximum[k] > run["limit"][k] for k in KEYS):
            raise Refused("remaining_reservation_exhausted")
        run["pending"] = dict(name=name, maximum=maximum)
        self.save()
        if time.time() >= run["deadline"] or today() != run["day"]:
            raise Refused("reserved_batch_expired_before_dispatch")
        actual = counts(operation())
        run["spent"] = {k: run["spent"][k] + actual[k] for k in KEYS}
        if any(actual[k] > maximum[k] for k in KEYS) or today() != run["day"]:
            run["pending"]["observed"] = actual
            self.save()
            raise Refused("observed_cost_outside_reservation")
        run["pending"] = None
        self.save()
        return actual
