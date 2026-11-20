"""Recover the sealed pre-promotion checkpoint from a successful protected requalification."""
import argparse
import json
import os
from pathlib import Path

from unsealed_stage import resealed_document, verify_dispatch


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--artifact-id", required=True)
    parser.add_argument("--sha256", required=True)
    parser.add_argument("--out", required=True, type=Path)
    args = parser.parse_args()
    revision = os.environ["GITHUB_SHA"]
    verify_dispatch(os.environ)
    if os.environ["FIXTURE_RELEASE_OPERATION"] != "recover-fixture-fallback":
        raise ValueError("The recovery operation must independently authenticate its seal")
    stage = resealed_document(revision, args.artifact_id, args.sha256)
    destination = Path(os.environ["RUNNER_TEMP"]) / "native-fallback-stage.json"
    if args.out != destination:
        raise ValueError("Use the designated runner-local fallback checkpoint")
    with os.fdopen(os.open(destination, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), "w") as file:
        json.dump(stage, file)


if __name__ == "__main__":
    main()
