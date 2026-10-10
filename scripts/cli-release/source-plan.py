#!/usr/bin/env python3
"""Decode the reviewed source selection recipe without acquiring or executing source."""
import importlib.util
import json
from pathlib import Path
import re

spec = importlib.util.spec_from_file_location("cli_source_contract", Path(__file__).with_name("publish-source.py"))
contract = importlib.util.module_from_spec(spec)
spec.loader.exec_module(contract)
MAX_PLAN = 128 * 1024


def paths(values):
    contract.require(type(values) is list and len(values) < contract.MAX_ENTRIES,
                     "Source plan paths exceed their bounded list.")
    for value in values:
        contract.canonical_path(value)
    contract.require(len(set(values)) == len(values), "Source plan paths contain duplicates.")
    return values


def decode(raw, cli_version, bun_revision):
    """Return a strict, bounded plan for the exact release and runtime identity."""
    contract.require(type(raw) is bytes and 0 < len(raw) <= MAX_PLAN, "Source plan exceeds its byte limit.")
    plan = json.loads(raw.decode("utf-8"), object_pairs_hook=contract.unique_object)
    contract.require(type(plan) is dict and set(plan) == {
        "schema_version", "cli_version", "bun_revision", "manifest_sha256", "application_inputs",
        "materials", "payload", "sources"} and type(plan["schema_version"]) is int
        and plan["schema_version"] == 1, "Source plan schema is unsupported or has unexpected fields.")
    contract.require(plan["cli_version"] == cli_version == "0.1.0"
                     and plan["bun_revision"] == bun_revision and contract.hexadecimal(bun_revision, 40)
                     and contract.hexadecimal(plan["manifest_sha256"], 64),
                     "Source plan release identity or manifest commitment is invalid.")
    contract.require(all(path.startswith("apps/") for path in paths(plan["application_inputs"])),
                     "Source plan application input is outside apps.")
    materials = plan["materials"]
    contract.require(type(materials) is list and len(materials) < contract.MAX_ENTRIES,
                     "Source plan materials exceed their bounded list.")
    for material in materials:
        contract.require(type(material) is dict and set(material) == {"path", "checkout"},
                         "Source plan material fields are invalid.")
        contract.canonical_path(material["checkout"])
    paths([material["path"] for material in materials])
    payload = plan["payload"]
    contract.require(type(payload) is dict and set(payload) == {"bytes", "sha256"}
                     and type(payload["bytes"]) is int and 0 < payload["bytes"] <= contract.MAX_FILE
                     and contract.hexadecimal(payload["sha256"], 64), "Source plan payload pin is invalid.")
    sources = plan["sources"]
    contract.require(type(sources) is list and 0 < len(sources) <= 32, "Source plan repository count is invalid.")
    identities = set()
    for source in sources:
        contract.require(type(source) is dict and set(source) == {
            "repository", "revision", "destination", "prefixes", "aliases", "omitted_symlinks"},
            "Source plan repository fields are invalid.")
        repository, revision = source["repository"], source["revision"]
        contract.require(type(repository) is str and re.fullmatch(
            r"[A-Za-z0-9][A-Za-z0-9_.-]*/[A-Za-z0-9][A-Za-z0-9_.-]*", repository)
            and contract.hexadecimal(revision, 40), "Source plan Git identity is invalid.")
        contract.require((repository, revision) not in identities, "Source plan repeats a repository identity.")
        identities.add((repository, revision))
        contract.canonical_path(source["destination"])
        paths(source["prefixes"])
        paths(source["omitted_symlinks"])
        contract.require(type(source["aliases"]) is dict and len(source["aliases"]) <= 16,
                         "Source plan aliases exceed their bounded mapping.")
        for destination, path in source["aliases"].items():
            contract.canonical_path(destination)
            contract.canonical_path(path)
    return plan


def application_paths(plan):
    """Return the exact first-party input closure approved for the native build."""
    return set(plan["application_inputs"])


def select(source, tree):
    """Select regular pinned tree entries; only explicitly named symlinks may be omitted."""
    prefixes = source["prefixes"]
    for prefix in prefixes:
        contract.require(any(path == prefix or path.startswith(prefix + "/") for path in tree),
                         "Source plan prefix is missing from the pinned Git tree.")
    selected = {path: path for path in tree if not prefixes or any(
        path == prefix or path.startswith(prefix + "/") for prefix in prefixes)}
    omitted = set(source["omitted_symlinks"])
    contract.require(omitted.issubset(selected), "Source plan omits a path outside its selected tree.")
    for path in omitted:
        contract.require(tree[path][0:2] == ["120000", "blob"],
                         "Source plan omission is not a pinned symlink.")
        del selected[path]
    for destination, path in source["aliases"].items():
        contract.require(destination not in selected and path in tree,
                         "Source plan alias is missing or collides with selected source.")
        selected[destination] = path
    result = []
    for destination, path in sorted(selected.items()):
        contract.canonical_path(path)
        mode, kind, blob = tree[path]
        contract.require(mode in ("100644", "100755") and kind == "blob"
                         and contract.hexadecimal(blob, 40), "Selected Git source is not a regular pinned blob.")
        destination = contract.canonical_path(source["destination"] + "/" + destination)
        result.append({"path": destination, "mode": int(mode, 8) & 0o777,
                       "origin": {"kind": "git", "repository": source["repository"],
                                  "revision": source["revision"], "path": path, "git_blob_sha1": blob}})
    contract.require(0 < len(result) < contract.MAX_ENTRIES, "Selected source count exceeds its limit.")
    return result
