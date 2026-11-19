"""Reserve a bounded batch durably before issuing it. Account-wide admission precedes the ledger."""
import datetime as dt
import fcntl
import json
import os
from pathlib import Path
import re
import subprocess

KEYS = ("rowsRead", "rowsWritten")


class Refused(ValueError):
    pass


def counts(raw):
    if not isinstance(raw, dict) or any(type(raw.get(k)) is not int or not 0 <= raw[k] <= 2**53 - 1 for k in KEYS):
        raise Refused("Missing native D1 counters")
    return {k: raw[k] for k in KEYS}


def today():
    return dt.datetime.now(dt.timezone.utc).date().isoformat()


def admit(root, account, observation, full_estimate):
    result = subprocess.run(["bun", "scripts/infra-performance/d1-budget.ts"], cwd=root,
                            input=json.dumps(dict(accountId=account, observation=observation, estimate=counts(full_estimate))),
                            capture_output=True, text=True, timeout=15)
    decision = json.loads(result.stdout)
    if result.returncode or decision.get("_tag") != "Allowed" or observation["utcDate"] != today():
        raise Refused("Shared-account D1 preflight refused")
    return decision


class Ledger:
    def __init__(self, directory, account, decision):
        if not re.fullmatch(r"[a-f0-9]{32}", account) or decision.get("_tag") != "Allowed":
            raise Refused("Missing account admission")
        self.limit = counts(dict(rowsRead=decision.get("maximumRowsRead"), rowsWritten=decision.get("maximumRowsWritten")))
        self.directory = Path(directory) / account
        self.path = self.directory / "ledger.json"
        self.day = today()

    def __enter__(self):
        self.directory.mkdir(parents=True, exist_ok=True, mode=0o700)
        self.lock = (self.directory / "account.lock").open("a")
        try:
            fcntl.flock(self.lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            state = json.loads(self.path.read_text()) if self.path.exists() else None
            if state and state["day"] == self.day:
                if state["pending"] is not None:
                    raise Refused("Previous D1 cost is unresolved for this UTC day")
                self.spent = counts(state["spent"])
            else:
                self.spent = dict(rowsRead=0, rowsWritten=0)
            return self
        except BaseException:
            self.lock.close()
            raise

    def __exit__(self, *args):
        self.lock.close()

    def record(self, pending):
        temporary = self.path.with_suffix(".tmp")
        with temporary.open("w") as stream:
            json.dump(dict(day=self.day, spent=self.spent, pending=pending), stream)
            stream.flush()
            os.fsync(stream.fileno())
        temporary.replace(self.path)
        fd = os.open(self.directory, os.O_RDONLY)
        try:
            os.fsync(fd)
        finally:
            os.close(fd)

    def batch(self, name, maximum, operation):
        bounded = counts(maximum)
        if self.path.exists():
            existing = json.loads(self.path.read_text())
            if existing["pending"] is not None and existing["day"] == self.day:
                raise Refused("A previous batch has unresolved native D1 cost")
        if today() != self.day or any(self.spent[k] + bounded[k] > self.limit[k] for k in KEYS):
            raise Refused("Remaining admitted ceiling cannot cover this batch")
        self.record(dict(name=name, maximum=bounded))
        actual = counts(operation())
        self.spent = {k: self.spent[k] + actual[k] for k in KEYS}
        if today() != self.day or any(actual[k] > bounded[k] for k in KEYS):
            self.record(dict(name=name, maximum=bounded, exceededOrCrossedDay=actual))
            raise Refused("Native D1 cost exceeded the batch reservation or crossed midnight")
        self.record(None)
        return actual
