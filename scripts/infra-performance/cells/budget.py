"""Check native D1 row counters and run the canonical account-wide budget policy."""
import datetime as dt
import json
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
