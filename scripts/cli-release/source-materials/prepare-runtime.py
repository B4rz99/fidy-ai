#!/usr/bin/env python3
"""Verify this source packet and optionally create a recipient-only working copy.

This command never downloads, compiles, or executes upstream source. The new
working copy is deliberately separate from the distributor's pinned build.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import stat
import sys


def require(condition, message):
    if not condition:
        raise ValueError(message)


def source_bytes(root, name, limit):
    require(type(name) is str and 0 < len(name.encode("utf-8")) <= 255 and
            not any(ord(char) < 32 or char in "\\:*?\"<>|" for char in name), "Unsafe source path.")
    path = PurePosixPath(name)
    require(not path.is_absolute() and path.as_posix() == name and
            all(part not in ("", ".", "..") for part in path.parts), "Unsafe source path.")
    current = root
    for part in path.parts:
        current = current / part
        require(not current.is_symlink(), "Source packet contains a symlink.")
    info = current.stat()
    require(stat.S_ISREG(info.st_mode) and info.st_size <= limit, "Invalid source file.")
    with current.open("rb") as stream:
        data = stream.read(limit + 1)
    require(len(data) <= limit, "Source file exceeded its byte limit.")
    return data


def unique_object(pairs):
    result = {}
    for key, value in pairs:
        require(key not in result, "Duplicate JSON key in source inventory.")
        result[key] = value
    return result


def verify(root):
    inventory = json.loads(source_bytes(root, "SOURCE-FILES.json", 8 * 1024 * 1024), object_pairs_hook=unique_object)
    require(set(inventory) == {"schema_version", "cli_version", "files"} and
            type(inventory["schema_version"]) is int and inventory["schema_version"] == 1 and inventory["cli_version"] == "0.1.0",
            "Invalid source inventory.")
    records = inventory["files"]
    require(isinstance(records, list) and 0 < len(records) < 20000, "Invalid source file count.")
    names = []
    total = 0
    for record in records:
        require(set(record) == {"path", "mode", "bytes", "sha256"}, "Invalid source record.")
        require(type(record["bytes"]) is int and 0 <= record["bytes"] <= 16 * 1024 * 1024 and
                type(record["mode"]) is int and record["mode"] in (0o644, 0o755) and
                type(record["sha256"]) is str and re.fullmatch(r"[0-9a-f]{64}", record["sha256"]),
                "Invalid source size, mode or digest.")
        total += record["bytes"]
        require(total <= 512 * 1024 * 1024, "Source packet exceeded its byte budget.")
        data = source_bytes(root, record["path"], record["bytes"])
        require(len(data) == record["bytes"] and hashlib.sha256(data).hexdigest() == record["sha256"],
                "Source bytes differ: " + record["path"])
        names.append(record["path"])
    require(names == sorted(set(names)) and len({name.casefold() for name in names}) == len(names),
            "Duplicate or unsorted source paths.")
    require(total <= 512 * 1024 * 1024, "Source packet exceeded its byte budget.")
    metadata = json.loads(source_bytes(root, "SOURCE-RELEASE.json", 1024), object_pairs_hook=unique_object)
    require(set(metadata) == {"schema_version", "cli_version", "bun_revision", "source_commit"} and
            type(metadata["schema_version"]) is int and metadata["schema_version"] == 1 and metadata["cli_version"] == "0.1.0" and
            metadata["bun_revision"] == "13a98b0dbd136bcc5c98a8adfb53c909aa3183cc" and
            isinstance(metadata["source_commit"], str) and len(metadata["source_commit"]) == 40 and
            all(char in "0123456789abcdef" for char in metadata["source_commit"]),
            "Invalid release source binding.")
    actual = set()
    for path in root.rglob("*"):
        require(not path.is_symlink(), "Source packet contains a symlink.")
        if path.is_file():
            actual.add(path.relative_to(root).as_posix())
            require(len(actual) <= 20000, "Source packet has too many files.")
        else:
            require(path.is_dir(), "Source packet contains a special file.")
    require(actual == set(names) | {"SOURCE-FILES.json", "SOURCE-RELEASE.json"},
            "Source packet has missing or extra files.")
    return records


def replace_once(path, before, after):
    original = path.read_text(encoding="utf-8")
    require(original.count(before) == 1, "Recipient preparation no longer matches supplied source.")
    path.write_text(original.replace(before, after), encoding="utf-8", newline="")


def prepare(root, output, records):
    require(output.is_absolute() and not output.exists() and not output.is_symlink(),
            "Choose a new absolute output directory.")
    parent = output.parent.resolve(strict=True)
    require(parent == output.parent and not parent.is_relative_to(root),
            "Output parent must be canonical and outside the source packet.")
    # mkdir is the no-overwrite boundary. A later failure leaves a clearly
    # incomplete new directory and never replaces the recipient's old work.
    output.mkdir(mode=0o700)
    for record in records:
        name = record["path"]
        if not name.startswith(("bun/", "webkit/", "tinycc/")):
            continue
        destination = output / name
        destination.parent.mkdir(parents=True, exist_ok=True)
        with destination.open("xb") as stream:
            stream.write(source_bytes(root, name, record["bytes"]))
        os.chmod(destination, record["mode"])
    webkit_recipe = output / "bun/scripts/build/deps/webkit.ts"
    replace_once(webkit_recipe, '      PORT: "JSCOnly",',
                 '      PORT: "JSCOnly",\n      ENABLE_TOOLS: "OFF",\n      USE_SYSTEM_UNIFDEF: "ON",')
    replace_once(webkit_recipe, '          "-ExecutionPolicy",\n          "Bypass",\n', "")
    replace_once(output / "webkit/Source/cmake/OptionsJSCOnly.cmake",
                 "if (WIN32)\n    set(ENABLE_API_TESTS OFF)\nelse ()\n    set(ENABLE_API_TESTS ON)\nendif ()",
                 "# Fidy recipient source preparation: omit optional upstream API test targets.\nset(ENABLE_API_TESTS OFF)")
    prepared_header = source_bytes(root, "recipe/tinycc-tcc.h", 1024 * 1024)
    (output / "tinycc/tcc.h").write_bytes(prepared_header)
    (output / "RECIPIENT-MODIFICATIONS.txt").write_text(
        "Recipient-only source preparation, Fidy CLI 0.1.0.\n"
        "Bun WebKit recipe: disable optional Tools; use installed system unifdef; respect PowerShell policy.\n"
        "WebKit OptionsJSCOnly: disable optional API tests. TinyCC tcc.h: apply the supplied Bun patch.\n"
        "All other supplied source bytes are unchanged. This is not the distributor's binary build.\n",
        encoding="utf-8")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, help="new absolute recipient working directory")
    args = parser.parse_args()
    root = Path(__file__).resolve().parent
    records = verify(root)
    if args.output is not None:
        prepare(root, args.output, records)
        print("Prepared recipient source in " + str(args.output))
    else:
        print("Verified the source packet; no files changed.")


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError, TypeError, KeyError) as error:
        print("Source preparation failed: " + str(error), file=sys.stderr)
        sys.exit(1)
