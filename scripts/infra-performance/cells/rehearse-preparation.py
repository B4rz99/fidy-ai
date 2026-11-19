"""Check the protected pilot's pre-provision result and disposal of an interrupted local fixture."""
import argparse
import json
import os
from pathlib import Path
import socket
import subprocess
import tempfile

HERE = Path(__file__).resolve().parent


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--canonical", type=Path, required=True)
    parser.add_argument("--historical", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()
    args.out.mkdir(parents=True, exist_ok=False)
    with tempfile.TemporaryDirectory(prefix="fidy-2259-preparation-") as scratch:
        environment = {"PATH": os.environ["PATH"], "HOME": scratch, "TMPDIR": scratch}
        for bundle, reason, name in [(args.canonical, "experiment_too_large", "canonical"),
                                     (args.historical, "protected_preparation_receipt_missing", "historical")]:
            out = args.out / name
            result = subprocess.run(["/usr/bin/python3", str(HERE / "pilot.py"), "--bundle", str(bundle),
                                     "--out", str(out)], env=environment, timeout=30, check=False)
            report = json.loads((out / "report.json").read_text())
            if (result.returncode != 1 or report.get("reason") != reason or report["attempts"]
                    or report["preparedReceipt"] != "missing"):
                raise ValueError("The unprepared protected pilot did not report its expected refusal")
        subprocess.run(["bun", str(HERE / "probe.mjs"), str(args.canonical.resolve()),
                        "interrupt-preparation"], env=environment, check=True, timeout=120)
        interrupted = json.loads((args.canonical / "interruption.json").read_text())
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
