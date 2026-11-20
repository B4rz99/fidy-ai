"""Check the protected pilot's pre-provision result and disposal of an interrupted local fixture."""
import argparse
import json
import os
from pathlib import Path
import socket
import subprocess
import tempfile

HERE = Path(__file__).resolve().parent


def check_materialized_cohort(bundle, environment):
    snapshot = json.loads((bundle / "snapshot-proof.json").read_text())
    probe = json.loads((bundle / "probe.json").read_text())
    if (snapshot["scope"] != "complete pre-Login fixture" or snapshot["stage"] != "equivalent"
            or probe["result"] != "passed" or probe["auditReads"] != 30 or probe["comparedInspections"] != 8):
        raise ValueError("The complete materialized fixture and authenticated cohort must be verified")
    estimate = probe["fullEstimate"]["thirtyPairs"]
    policy = HERE.parent / "d1-budget.ts"
    reply = subprocess.run(["bun", str(policy), "--estimate-only"], input=json.dumps(estimate),
                           env=environment, capture_output=True, text=True, check=False, timeout=15)
    if reply.returncode != 1 or json.loads(reply.stdout) != {"_tag": "NeedsAccountObservation"}:
        raise ValueError("The materialized 30-pair plan exceeds the shared experiment ceiling")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--materialized", type=Path, required=True)
    parser.add_argument("--empty-schema", type=Path, required=True)
    parser.add_argument("--historical", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()
    args.out.mkdir(parents=True, exist_ok=False)
    with tempfile.TemporaryDirectory(prefix="fidy-2259-preparation-") as scratch:
        environment = {"PATH": os.environ["PATH"], "HOME": scratch, "TMPDIR": scratch}
        for bundle, reason, name in [(args.materialized, "protected_preparation_receipt_missing", "materialized"),
                                     (args.empty_schema, "experiment_too_large", "empty-schema"),
                                     (args.historical, "protected_preparation_receipt_missing", "historical")]:
            out = args.out / name
            result = subprocess.run(["/usr/bin/python3", str(HERE / "pilot.py"), "--bundle", str(bundle),
                                     "--out", str(out)], env=environment, timeout=30, check=False)
            report = json.loads((out / "report.json").read_text())
            if (result.returncode != 1 or report.get("reason") != reason or report["attempts"]
                    or report["preparedReceipt"] != "missing"):
                raise ValueError("The unprepared protected pilot did not report its expected refusal")
        check_materialized_cohort(args.materialized, environment)
        subprocess.run(["bun", str(HERE / "probe.mjs"), str(args.materialized.resolve()),
                        "interrupt-preparation"], env=environment, check=True, timeout=120)
        interrupted = json.loads((args.materialized / "interruption.json").read_text())
        if interrupted["result"] != "interrupted after verified canonical setup" or interrupted["disposed"] is not True:
            raise ValueError("Missing interrupted setup and disposal proof")
        try:
            with socket.create_connection(("127.0.0.1", interrupted["localPort"]), timeout=2):
                raise ValueError("Disposed comparator endpoint still accepts connections")
        except ConnectionRefusedError:
            pass
    if Path(scratch).exists():
        raise ValueError("Owned temporary workerd directory survived cleanup")
    (args.out / "cleanup.json").write_text(json.dumps({
        "scope": "private GitHub runner workerd", "phase": interrupted["result"],
        "endpointConnectionRefused": True, "ownedTemporaryDirectoryAbsent": True,
        "hostedResourceObservations": [],
    }, indent=2))


if __name__ == "__main__":
    main()
