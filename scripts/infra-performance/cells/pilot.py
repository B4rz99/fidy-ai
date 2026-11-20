"""Check the frozen package size without cloud credentials. Hosted collection uses owner.py."""
import argparse
import hashlib
import json
from pathlib import Path
import subprocess

from budget import Refused, counts
from comparison import FIXTURE
from prepare import PIN, HERE

ROOT = HERE.parents[2]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--prepared", type=Path, help="Protected deployment and prior-cost receipt")
    parser.add_argument("--bundle", type=Path, required=True, help="Verified offline comparator artifact")
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()
    report = {"status": "missing", "scope": "one hosted Transactions pilot", "attempts": [], "lifecycle": "unobserved",
              "protectedEntry": "python3 scripts/infra-performance/cells/owner.py --help"}
    args.out.mkdir(parents=True, exist_ok=False)
    def save():
        (args.out / "report.json").write_text(json.dumps(report, indent=2))
    save()
    try:
        if not (args.bundle / "manifest.json").is_file():
            raise Refused("verified_bundle_missing")
        manifest = json.loads((args.bundle / "manifest.json").read_bytes())
        if manifest["baseline"] != PIN:
            raise Refused("pinned_comparator_mismatch")
        def checked_json(key):
            raw = (args.bundle / (key + ".json")).read_bytes()
            if hashlib.sha256(raw).hexdigest() != manifest["sha256"][key]:
                raise Refused("bundle_digest_mismatch")
            return json.loads(raw)
        probe = checked_json("probe")
        if probe["result"] != "passed" or probe["baseline"] != PIN or probe["fixture"] != FIXTURE:
            raise Refused("verified_rehearsal_missing")
        verified = counts(probe["fullEstimate"]["onePair"])
        report["fullEstimate"] = verified
        plan = checked_json("plan")
        canonical = plan.get("canonicalTransactionFixture")
        if canonical is not None:
            if canonical["observedOriginals"] != 8 or probe["comparedInspections"] != 8:
                raise Refused("canonical_fixture_mismatch")
            report["fixtureEvidence"] = "disposable native workerd"
        else:
            report["fixtureEvidence"] = "historical fixed originals"
        report["preparedReceipt"] = "supplied" if args.prepared else "missing"
        preliminary = subprocess.run(
            ["bun", "scripts/infra-performance/d1-budget.ts", "--estimate-only"], cwd=ROOT,
            input=json.dumps(verified), capture_output=True, text=True, timeout=15)
        verdict = json.loads(preliminary.stdout)
        if verdict == {"_tag":"Refused", "reason":"experiment_too_large"}:
            raise Refused("experiment_too_large")
        if verdict != {"_tag":"NeedsAccountObservation"}:
            raise Refused("invalid_estimate")
        if args.prepared is None or not args.prepared.is_file():
            raise Refused("protected_preparation_receipt_missing")
        raise Refused("protected_owner_required")
    except Exception as error:
        report.update(status="stopped", error=type(error).__name__)
        if isinstance(error, Refused):
            report["reason"] = str(error)
        save()
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
