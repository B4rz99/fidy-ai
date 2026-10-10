#!/usr/bin/env python3
"""Check that an actual native build stays within the reviewed application closure."""
import argparse
import importlib.util
import json
from pathlib import Path
import sys

spec = importlib.util.spec_from_file_location("cli_source_plan", Path(__file__).with_name("source-plan.py"))
plan_contract = importlib.util.module_from_spec(spec)
spec.loader.exec_module(plan_contract)
contract = plan_contract.contract


def verify(metadata, expected):
    actual = set(metadata["inputs"])
    contract.require({name for name in actual if name.startswith("apps/")} == expected,
                     "Native application inputs differ from the reviewed source packet.")
    prefixes = ("node_modules/effect/", "node_modules/@effect/platform-bun/", "node_modules/@effect/platform-node-shared/")
    contract.require(all(name.startswith("apps/") or name.startswith(prefixes) for name in actual),
                     "Native application includes an unreviewed dependency.")
    contract.require(len(metadata["outputs"]) == 1, "Native build has an unexpected output set.")
    output = next(iter(metadata["outputs"].values()))
    contract.require(output["entryPoint"] == "apps/cli/src/main.ts" and not output["imports"],
                     "Native build has a different entry point or external application imports.")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("metafile", type=Path)
    args = parser.parse_args()
    raw_plan = contract.file_bytes(Path(__file__).with_name("source-plan.json"), plan_contract.MAX_PLAN)
    plan = plan_contract.decode(raw_plan, "0.1.0", "13a98b0dbd136bcc5c98a8adfb53c909aa3183cc")
    metadata = json.loads(contract.file_bytes(args.metafile, contract.MAX_SPEC))
    verify(metadata, plan_contract.application_paths(plan))
    print("Native application input closure matches the reviewed source packet.")


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError, TypeError, KeyError, contract.SourceError):
        print("Native application source-closure verification failed.", file=sys.stderr)
        sys.exit(1)
