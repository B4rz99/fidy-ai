"""Inspect or dispose the pinned incumbent from a protected production workflow."""
import argparse
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import sys
import subprocess

from disposition import KINDS, SCOPE, digest, dispose, hold_reasons, inventory
from opening_source import authenticated_activity, authenticated_opening
from provider import Provider, Refused, require
from provenance import RETIREMENT_WORKFLOW, authenticated_archive, protected_runner

PLAN = "incumbent-inventory.json"
PLAN_ARCHIVE = "incumbent-retirement-inventory-"


def now():
    return datetime.now(timezone.utc)


def read_opening():
    return authenticated_opening(os.environ["OPENING_ARTIFACT"], os.environ["OPENING_SHA256"])


def write(path, value):
    path.write_text(json.dumps(value, sort_keys=True) + "\n", encoding="utf-8")


def load_inventory(opening, provider):
    source, _ = authenticated_archive(
        os.environ["INVENTORY_ARTIFACT"], os.environ["INVENTORY_SHA256"],
        RETIREMENT_WORKFLOW, PLAN, PLAN_ARCHIVE,
    )
    require(set(source) == {"account", "zone", "created", "revision", "scope", "snapshot", "holds"} and
            source["account"] == provider.account and source["zone"] == provider.zone and
            source["scope"] == digest(SCOPE) and source["revision"] == opening["revision"],
            "Protected incumbent inventory belongs to another release or scope")
    created = datetime.fromisoformat(source["created"])
    require(created.tzinfo is not None and created <= now(), "Invalid protected inventory time")
    require(source["holds"] == [], "Protected inventory has unresolved incumbent custody")
    return source["snapshot"]


def run(mode):
    protected_runner()
    os.umask(0o077)
    out = Path(os.environ["RUNNER_TEMP"])
    opening = read_opening()
    provider = Provider(
        account=os.environ["CLOUDFLARE_ACCOUNT_ID"], zone=opening["zone"],
        token=os.environ["CLOUDFLARE_API_TOKEN"], builds_token=os.environ["CLOUDFLARE_BUILDS_READ_TOKEN"],
    )
    require(provider.account == opening["account"], "Opening proof belongs to another account")
    evidence = {"revision": opening["revision"], "opening": digest(opening)}
    if mode == "inventory":
        snapshot = inventory(provider, opening)
        require(all(set(snapshot["targets"][kind]) == set(SCOPE[kind]) for kind in KINDS) and
                set(snapshot["legacyNamespaces"]) == set(SCOPE["legacyNamespaces"]),
                "Initial retirement inventory did not observe every pinned incumbent target")
        provider.verify_public_health(opening)
        write(out / PLAN, {
            "account": provider.account, "zone": provider.zone, "created": now().isoformat(),
            "revision": opening["revision"], "scope": digest(SCOPE), "snapshot": snapshot,
            "holds": hold_reasons(snapshot),
        })
        return

    authenticated_activity(os.environ["ACTIVITY_ARTIFACT"], os.environ["ACTIVITY_SHA256"], opening,
                           os.environ["OPENING_ARTIFACT"], os.environ["OPENING_SHA256"])
    approved = load_inventory(opening, provider)
    evidence["activityArtifact"] = os.environ["ACTIVITY_ARTIFACT"]
    with (out / "incumbent-disposition.jsonl").open("x", encoding="utf-8") as record:
        def checkpoint(row):
            record.write(json.dumps({**evidence, **row, "observed": now().isoformat()}) + "\n")
            record.flush()
        checkpoint({"status": "started", "inventory": os.environ["INVENTORY_ARTIFACT"]})
        dispose(provider, opening, approved, checkpoint)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("operation", choices=("inventory", "dispose"))
    args = parser.parse_args()
    try:
        run(args.operation)
    except (Refused, ValueError, OSError, KeyError, TypeError, subprocess.SubprocessError) as failure:
        message = str(failure) if isinstance(failure, Refused) else "Protected retirement evidence is incomplete"
        print(message, file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
