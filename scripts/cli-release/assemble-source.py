#!/usr/bin/env python3
"""Assemble a reviewed source asset in a read-only release job.

Only immutable official Git objects and the exact checked-out application are
inputs. Downloaded upstream code is never executed. Failures do not trigger a
retry or select another source. The publisher independently validates the result.
"""
import argparse
import gzip
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import stat
import subprocess
import sys
import tempfile


def load_sibling(name, filename):
    spec = importlib.util.spec_from_file_location(name, Path(__file__).with_name(filename))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


publisher = load_sibling("cli_publisher", "publish.py")
contract = load_sibling("cli_source_contract", "publish-source.py")
bundle = load_sibling("cli_bundle_contract", "verify-bundle.py")
plan_contract = load_sibling("cli_source_plan", "source-plan.py")
require = publisher.require


def git_blob(data):
    return hashlib.sha1(b"blob " + str(len(data)).encode() + b"\0" + data).hexdigest()


def checked_bytes(path, entry):
    require(not any(parent.is_symlink() for parent in (path, *path.parents)),
            "Source input cannot traverse a symlink.")
    require(stat.S_ISREG(path.stat().st_mode) and path.stat().st_size == entry["bytes"],
            "Source input is not the reviewed regular file.")
    with path.open("rb") as stream:
        data = stream.read(entry["bytes"] + 1)
    check_content(data, entry)
    return data


def check_content(data, entry):
    require(len(data) == entry["bytes"] and hashlib.sha256(data).hexdigest() == entry["sha256"],
            "Source input does not match its reviewed size and SHA-256.")
    if "git_blob_sha1" in entry.get("origin", {}):
        require(git_blob(data) == entry["origin"]["git_blob_sha1"], "Source Git blob identity differs.")


def git_command(directory, arguments, environment, *, input_bytes=None):
    command = ["git", "-c", "credential.helper=", "-c", "credential.interactive=false",
               "-c", "http.followRedirects=false", "-c", "protocol.file.allow=never",
               "-c", "protocol.ext.allow=never", "-c", "core.hooksPath=" + environment["FIDY_EMPTY_HOOKS"],
               "-C", str(directory), *arguments]
    result = subprocess.run(command, input=input_bytes, capture_output=True, env=environment, timeout=1200)
    require(result.returncode == 0, "Immutable public Git source acquisition failed; no retry was attempted.")
    require(len(result.stdout) <= 64 * 1024 * 1024, "Git source metadata exceeded its byte limit.")
    return result.stdout


def object_metadata(group, objects, environment):
    query = ("\n".join(sorted(objects)) + "\n").encode("ascii")
    records = git_command(group, ["cat-file", "--batch-check"], environment, input_bytes=query).splitlines()
    require(len(records) == len(objects), "Git object metadata count differs from selected source.")
    result = {}
    for record in records:
        fields = record.decode("ascii").split()
        require(len(fields) in (2, 3) and fields[0] in objects and fields[0] not in result,
                "Git object metadata identity differs from selected source.")
        if len(fields) == 2:
            require(fields[1] == "missing", "Git object metadata is invalid.")
            result[fields[0]] = None
        else:
            require(fields[1] == "blob" and fields[2].isdigit() and int(fields[2]) <= contract.MAX_FILE,
                    "Git object metadata type or size is invalid.")
            result[fields[0]] = int(fields[2])
    return result


def acquire_sources(cache, components, *, repositories=None, source_reader=None):
    """Fetch exact selected Git objects without checkout, credentials or redirects."""
    require(not cache.is_symlink(), "Source cache cannot be a symlink.")
    cache.mkdir(mode=0o700, parents=False, exist_ok=True)
    require(cache.is_dir(), "Source cache is not a directory.")
    home = cache / "git-home"
    hooks = cache / "empty-hooks"
    for directory in (home, hooks):
        require(not directory.exists(), "Git isolation directory already exists.")
        directory.mkdir(mode=0o700)
    # Preserve transport policy and trust roots, while excluding ambient Git
    # credentials/configuration, askpass helpers and GitHub tokens.
    preserved = {"PATH", "SYSTEMROOT", "WINDIR", "TEMP", "TMP", "LANG", "LC_ALL",
                 "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY", "http_proxy", "https_proxy",
                 "all_proxy", "no_proxy", "SSL_CERT_FILE", "SSL_CERT_DIR", "CURL_CA_BUNDLE"}
    environment = {key: value for key, value in os.environ.items() if key in preserved}
    environment.update({"HOME": str(home), "XDG_CONFIG_HOME": str(home), "GIT_CONFIG_NOSYSTEM": "1",
                        "GIT_CONFIG_GLOBAL": os.devnull, "GIT_TERMINAL_PROMPT": "0", "GIT_NO_LAZY_FETCH": "1",
                        "GIT_ASKPASS": "", "GIT_NO_REPLACE_OBJECTS": "1", "FIDY_EMPTY_HOOKS": str(hooks)})
    groups = {(component["repository"], component["revision"]): component for component in components}
    sources, generated, total = {}, [], 0
    try:
        for (repository, revision), selected in sorted(groups.items()):
            group = (repositories[(repository, revision)] if repositories is not None else
                     cache / hashlib.sha256((repository + "\0" + revision).encode()).hexdigest())
            require(not any(path.is_symlink() for path in (group, *group.parents)),
                    "Source repository cache cannot be a symlink.")
            fresh = repositories is None and not group.exists()
            identity = (repository + "@" + revision + "\n").encode("ascii")
            if repositories is None and not fresh:
                require(publisher.regular_bytes(group / "source-complete", 512) == identity,
                        "Source cache is incomplete; no acquisition retry was attempted.")
            if fresh:
                group.mkdir(mode=0o700)
                git_command(group, ["init", "--bare", "--template="], environment)
                url = "https://github.com/" + repository + ".git"
                git_command(group, ["fetch", "--quiet", "--no-tags", "--depth=1", "--filter=blob:none",
                                    "--no-write-fetch-head", url, revision], environment)
            require(git_command(group, ["rev-parse", revision + "^{commit}"], environment).strip().decode() == revision,
                    "Upstream source commit differs from the reviewed revision.")
            tree = {}
            for record in git_command(group, ["ls-tree", "-rz", "--full-tree", revision], environment).split(b"\0"):
                if record:
                    fields, name = record.split(b"\t", 1)
                    path = name.decode("utf-8")
                    require(path not in tree, "Pinned Git tree repeats a path.")
                    tree[path] = fields.decode("ascii").split()
                    require(len(tree[path]) == 3, "Pinned Git tree metadata is invalid.")
            selected = plan_contract.select(selected, tree)
            objects = set()
            for entry in selected:
                origin = entry["origin"]
                expected = ["100755" if entry["mode"] == 0o755 else "100644", "blob", origin["git_blob_sha1"]]
                require(tree.get(origin["path"]) == expected, "Pinned source path, mode or Git blob does not match.")
                objects.add(origin["git_blob_sha1"])
            sizes = object_metadata(group, objects, environment)
            missing = [blob.encode("ascii") for blob, size in sizes.items() if size is None]
            require(fresh or source_reader is not None or not missing,
                    "Cached source objects are missing; no acquisition retry was attempted.")
            for start in range(0, len(missing) if fresh else 0, 256):
                git_command(group, ["-c", "fetch.negotiationAlgorithm=noop", "fetch", "--quiet", "--no-tags",
                                    "--no-write-fetch-head", "--stdin", "https://github.com/" + repository + ".git"],
                            environment, input_bytes=b"\n".join(missing[start:start + 256]) + b"\n")
            if missing and fresh:
                sizes = object_metadata(group, objects, environment)
            require(source_reader is not None or all(size is not None for size in sizes.values()),
                    "Selected Git source objects remain missing after bounded acquisition.")
            # Retain only selected, hash-verified bytes in the same-run cache.
            for entry in selected:
                data = (source_reader(entry) if source_reader is not None else
                        git_command(group, ["cat-file", "blob", entry["origin"]["git_blob_sha1"]], environment))
                require(len(data) <= contract.MAX_FILE
                        and (sizes[entry["origin"]["git_blob_sha1"]] in (None, len(data)))
                        and git_blob(data) == entry["origin"]["git_blob_sha1"],
                        "Source Git blob identity or byte limit differs.")
                entry.update(bytes=len(data), sha256=hashlib.sha256(data).hexdigest())
                check_content(data, entry)
                source = cache / (entry["sha256"] + ".source")
                if source.exists():
                    checked_bytes(source, entry)
                else:
                    with source.open("xb") as stream:
                        stream.write(data)
                sources[entry["path"]] = source
                generated.append(entry)
                total += entry["bytes"]
                require(len(generated) < contract.MAX_ENTRIES and total <= contract.MAX_TOTAL,
                        "Generated source exceeds its count or byte limit.")
            if fresh:
                with (group / "source-complete").open("xb") as stream:
                    stream.write(identity)
    finally:
        # Only our new empty isolation directories are removed. Source caches
        # survive failure for inspection; there is no automatic network retry.
        home.rmdir()
        hooks.rmdir()
    reader = lambda entry: checked_bytes(sources[entry["path"]], entry)
    return generated, reader


def source_row(path, data, origin, mode=0o644):
    require(len(data) <= contract.MAX_FILE, "Source file exceeds its byte limit.")
    return {"path": path, "mode": mode, "bytes": len(data),
            "sha256": hashlib.sha256(data).hexdigest(), "origin": origin}


def recipient_index(entries, version):
    return contract.canonical_json({"schema_version": 1, "cli_version": version,
        "files": [{key: entry[key] for key in ("path", "mode", "bytes", "sha256")}
                  for entry in sorted(entries, key=lambda item: item["path"])
                  if entry["path"] not in ("SOURCE-FILES.json", contract.RELEASE_METADATA)]})


def assemble_plan(root, raw_plan, version, source_commit, destination, cache, *,
                  repositories=None, source_reader=None, payload_builder=None):
    """Generate the committed manifest from pinned Git sources, then assemble its exact packet.

    Optional local repositories and byte reader are the offline acquisition boundary.
    They cannot bypass pinned tree, blob, checkout or final manifest validation.
    """
    plan = plan_contract.decode(raw_plan, version, publisher.RUNTIME_REVISION)
    require(publisher.git(root, "rev-parse", "HEAD").strip().decode() == source_commit,
            "Source assembly checkout differs from the expected release SHA.")
    entries, reader = acquire_sources(cache, components=plan["sources"],
                                     repositories=repositories, source_reader=source_reader)
    materials = plan["materials"] + [{"path": "application/original-source/" + path, "checkout": path}
                                     for path in plan["application_inputs"]]
    for material in materials:
        path = root / material["checkout"]
        require(not any(parent.is_symlink() for parent in (path, *path.parents)),
                "Source input cannot traverse a symlink.")
        data = publisher.regular_bytes(path, contract.MAX_FILE)
        tracked = publisher.git(root, "ls-tree", "HEAD", "--", material["checkout"]).split()
        require(len(tracked) == 4 and tracked[0] in (b"100644", b"100755") and tracked[1] == b"blob"
                and tracked[2].decode() == git_blob(data), "Source material is not the exact tracked Git input.")
        entries.append(source_row(material["path"], data,
            {"kind": "checkout", "path": material["checkout"], "git_blob_sha1": git_blob(data)},
            int(tracked[0], 8) & 0o777))
    entries.append({"path": "application/fidy-app.js", "mode": 0o644, **plan["payload"],
                    "origin": {"kind": "generated", "generator": "bun-build", "label": "application-payload"}})
    index = recipient_index(entries, version)
    entries.append(source_row("SOURCE-FILES.json", index,
        {"kind": "generated", "generator": "source-index", "label": "recipient-index"}))
    raw_spec = contract.canonical_json({"schema_version": 1, "cli_version": version,
        "bun_revision": publisher.RUNTIME_REVISION, "files": sorted(entries, key=lambda item: item["path"])})
    require(hashlib.sha256(raw_spec).hexdigest() == plan["manifest_sha256"],
            "Generated source manifest commitment differs from the reviewed plan.")
    return assemble(root, raw_spec, version, source_commit, destination, cache,
                    source_reader=reader, payload_builder=payload_builder or build_payload)


def build_payload(root, cache, entries):
    revision = subprocess.run(["bun", "--revision"], capture_output=True, cwd=root, timeout=30)
    require(revision.returncode == 0 and revision.stdout.strip() == b"1.4.3-canary.1+13a98b0db",
            "Source payload generation requires the reviewed Bun runtime.")
    with tempfile.TemporaryDirectory(prefix="cli-source-payload-", dir=cache) as temporary:
        output = Path(temporary) / "fidy-app.js"
        metafile = Path(temporary) / "metafile.json"
        result = subprocess.run(["bun", "build", "apps/cli/src/main.ts", "--target=bun", "--format=esm",
                                 "--metafile=" + str(metafile), "--outfile=" + str(output)], cwd=root,
                                capture_output=True, timeout=120)
        require(result.returncode == 0, "Application source payload generation failed.")
        metadata = json.loads(publisher.regular_bytes(metafile, 8 * 1024 * 1024))
        try:
            bundle.verify(metadata, {entry["origin"]["path"] for entry in entries
                if entry["origin"]["kind"] == "checkout" and entry["origin"]["path"].startswith("apps/")})
        except bundle.contract.SourceError:
            raise publisher.ReleaseError("Application source closure differs from the reviewed packet.") from None
        return publisher.regular_bytes(output, 16 * 1024 * 1024)


def assemble(root, raw_spec, version, source_commit, destination, cache, *, source_reader, payload_builder=build_payload):
    entries = contract.specification(raw_spec, cli_version=version, bun_revision=publisher.RUNTIME_REVISION,
                                     source_commit=source_commit)
    static = [entry for entry in entries if "origin" in entry]
    require(destination.is_absolute() and not destination.exists() and not destination.is_symlink(),
            "Source asset output must be a new absolute directory.")
    require(not any(path.is_symlink() for path in (destination.parent, *destination.parent.parents)),
            "Source output parent cannot traverse a symlink.")
    payload = payload_builder(root, cache, static)
    metadata = contract.source_metadata(version, publisher.RUNTIME_REVISION, source_commit)
    destination.mkdir(mode=0o700)
    name = "fidy-cli-v" + version + "-source.tar.gz"
    archive = destination / name
    with archive.open("xb") as stream:
        with gzip.GzipFile(filename="", mode="wb", compresslevel=9, fileobj=stream, mtime=0) as zipped:
            for entry in entries:
                origin = entry.get("origin", {})
                if entry["path"] == contract.RELEASE_METADATA:
                    data = metadata
                elif origin.get("generator") == "source-index":
                    data = recipient_index(static, version)
                elif origin["kind"] == "generated":
                    data = payload
                elif origin["kind"] == "checkout":
                    data = checked_bytes(root / origin["path"], entry)
                    tracked = publisher.git(root, "ls-tree", "HEAD", "--", origin["path"]).split()
                    require(len(tracked) == 4 and tracked[1] == b"blob" and tracked[2].decode() == origin["git_blob_sha1"],
                            "Application or recipe source is not the exact tracked Git input.")
                else:
                    data = source_reader(entry)
                check_content(data, entry)
                zipped.write(contract.canonical_header(entry))
                zipped.write(data)
                zipped.write(b"\0" * ((-len(data)) % 512))
            zipped.write(b"\0" * 1024)
    require(archive.stat().st_size <= contract.MAX_COMPRESSED, "Source archive exceeds its compressed limit.")
    digest = hashlib.sha256(archive.read_bytes()).hexdigest()
    (destination / (name + ".sha256")).write_bytes((digest + "  " + name + "\n").encode("ascii"))
    (destination / "source-spec.json").write_bytes(raw_spec)
    contract.validate_artifact(destination, raw_spec, cli_version=version, bun_revision=publisher.RUNTIME_REVISION,
                               source_commit=source_commit)
    return digest


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--version", required=True)
    parser.add_argument("--expected-sha", required=True)
    parser.add_argument("--destination", required=True, type=Path)
    parser.add_argument("--cache", required=True, type=Path)
    args = parser.parse_args(argv)
    root = Path(__file__).resolve().parents[2]
    require(publisher.git(root, "rev-parse", "HEAD").strip().decode() == args.expected_sha,
            "Source assembly checkout differs from the expected release SHA.")
    content = publisher.readiness(root, args.version)
    result = assemble_plan(root, content["source_plan"], args.version, args.expected_sha, args.destination, args.cache)
    print("Verified source asset SHA256 " + result)


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError, KeyError, TypeError, subprocess.TimeoutExpired,
            publisher.ReleaseError, contract.SourceError, plan_contract.contract.SourceError,
            publisher.source_plan.contract.SourceError):
        print("Source assembly failed; inspect the read-only job and its retained inputs before any retry.", file=sys.stderr)
        sys.exit(1)
