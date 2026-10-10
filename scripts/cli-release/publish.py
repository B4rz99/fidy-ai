#!/usr/bin/env python3
"""Validate reviewed CLI material and publish one immutable-by-policy release.

Only `publish` mutates GitHub. It refuses retries, existing releases/tags and
unverified material. Downloaded executables and installers are never executed.
All network I/O crosses the request argument to main, enabling offline seam tests.
"""
import argparse
import hashlib
import io
import os
import re
import stat
import zipfile
import urllib.error
import urllib.parse
import urllib.request
import subprocess
import json
from pathlib import Path
import sys


class ReleaseError(Exception):
    """A closed release failure safe to present without credentials or HTTP bodies."""


MANIFEST = "scripts/cli-release/publish-readiness.json"


def git(root, *args):
    result = subprocess.run(["git", "-C", str(root), *args], capture_output=True)
    if result.returncode:
        raise ReleaseError("Cannot verify the checked-out Git source.")
    return result.stdout


def source_digest(root):
    entries = git(root, "ls-tree", "-rz", "--full-tree", "HEAD").split(b"\0")
    included = sorted(entry for entry in entries if entry and entry.split(b"\t", 1)[1] != MANIFEST.encode())
    return hashlib.sha256(b"\0".join(included) + b"\0").hexdigest()


REPOSITORY = "B4rz99/fidy-ai"
RUNTIME_REVISION = "13a98b0dbd136bcc5c98a8adfb53c909aa3183cc"
MAX_ARCHIVE = 256 * 1024 * 1024
MAX_TEXT = 8 * 1024 * 1024
TARGETS = {
    "cli-candidate-Linux-X64": ("linux-x64", "fidy"),
    "cli-candidate-macOS-ARM64": ("darwin-arm64", "fidy"),
    "cli-candidate-Windows-X64": ("windows-x64", "fidy.exe"),
}
ATTESTATIONS = {
    "first_party_distribution_authorized", "bundled_inventory_complete",
    "required_notices_complete", "source_obligations_satisfied",
}
MATERIALS = {"inventory", "source_obligations", "BUN-LICENSE.txt", "THIRD-PARTY-NOTICES.txt"}


def require(condition, message):
    if not condition:
        raise ReleaseError(message)


def regular_bytes(path, limit):
    require(path.is_file() and not path.is_symlink(), "Required material is not a regular file.")
    require(0 < path.stat().st_size <= limit, "Release material is empty or exceeds its size limit.")
    with path.open("rb") as stream:
        data = stream.read(limit + 1)
    require(0 < len(data) <= limit, "Release material exceeds its streamed size limit.")
    return data


def readiness(root, version):
    manifest = json.loads(regular_bytes(root / MANIFEST, MAX_TEXT))
    require(type(manifest) is dict and manifest.get("status") == "approved",
            "Publication readiness is blocked: reviewed licensing and source evidence is incomplete.")
    require(set(manifest) == {"schema_version", "version", "status", "runtime_revision",
                             "source_tree_sha256", "review_reference", "attestations", "materials"},
            "Readiness manifest has unexpected or missing fields.")
    require(manifest["schema_version"] == 1 and type(manifest["schema_version"]) is int,
            "Unsupported readiness schema.")
    require(manifest["version"] == version and manifest["runtime_revision"] == RUNTIME_REVISION,
            "Readiness does not cover this version and pinned runtime.")
    require(type(manifest["review_reference"]) is str and re.fullmatch(
        r"https://github\.com/B4rz99/fidy-ai/(pull|issues)/[1-9][0-9]*(#[A-Za-z0-9_-]+)?",
        manifest["review_reference"]), "Readiness needs a specific repository review reference.")
    assertions = manifest["attestations"]
    require(type(assertions) is dict and set(assertions) == ATTESTATIONS
            and all(value is True for value in assertions.values()),
            "Distribution, inventory, notices and source obligations must all be reviewed.")
    require(manifest["source_tree_sha256"] == source_digest(root),
            "Reviewed source tree does not match this checkout.")
    materials = manifest["materials"]
    require(type(materials) is dict and set(materials) == MATERIALS,
            "Readiness needs all four reviewed evidence materials.")
    tracked = set(git(root, "ls-files", "-z").decode().split("\0"))
    content = {}
    for name, entry in materials.items():
        require(type(entry) is dict and set(entry) == {"path", "sha256"},
                "Readiness material requires a path and SHA-256.")
        relative = entry["path"]
        require(type(relative) is str and relative in tracked and relative != MANIFEST,
                "Readiness material must be a tracked source file.")
        path = root / relative
        require(path.resolve().is_relative_to(root.resolve()) and not any(
            ancestor.is_symlink() for ancestor in (path, *path.parents) if ancestor != root.parent),
            "Readiness material cannot traverse a symbolic link.")
        data = regular_bytes(path, MAX_TEXT)
        require(entry["sha256"] == hashlib.sha256(data).hexdigest(), "Reviewed material digest mismatch.")
        content[name] = data
    require(len({item["path"] for item in materials.values()}) == len(MATERIALS),
            "Inventory, source evidence and notices must be separate reviewed files.")
    review_evidence(content, version)
    for name in ("BUN-LICENSE.txt", "THIRD-PARTY-NOTICES.txt"):
        require(bool(content[name].decode('utf-8').strip()), "Reviewed notice text must not be blank.")
    require(not git(root, "status", "--porcelain", "--untracked-files=no"),
            "Tracked source changed after checkout.")
    return content


def review_evidence(content, version):
    inventory = json.loads(content["inventory"])
    require(type(inventory) is dict and inventory.get("schema_version") == 1
            and inventory.get("status") == "reviewed_complete" and inventory.get("version") == version
            and inventory.get("runtime_revision") == RUNTIME_REVISION,
            "Bundled inventory must be explicitly reviewed and complete for this release and runtime.")
    components = inventory.get("components")
    require(type(components) is list and 4 <= len(components) <= 10000,
            "Inventory must cover first-party code, runtime and both dependency classes.")
    kinds = {"first_party", "runtime", "runtime_dependency", "bundled_dependency"}
    identifiers = set()
    for component in components:
        require(type(component) is dict and set(component) == {
            "id", "kind", "version", "license", "source", "notice", "status"
        }, "Inventory component fields are incomplete or unexpected.")
        require(all(type(component[field]) is str and 0 < len(component[field].strip()) <= 8192
                    for field in component) and component["status"] == "reviewed"
                and component["kind"] in kinds and component["id"] not in identifiers,
                "Inventory contains an unresolved or duplicate component.")
        require(component["source"].startswith("https://"), "Each inventory component needs its reviewed source URL.")
        identifiers.add(component["id"])
    require({component["kind"] for component in components} == kinds,
            "Inventory is missing a required component class.")
    source = json.loads(content["source_obligations"])
    require(type(source) is dict and source.get("schema_version") == 1 and source.get("status") == "complete"
            and source.get("inventory_sha256") == hashlib.sha256(content["inventory"]).hexdigest(),
            "Source-obligation evidence is incomplete or does not match the inventory.")
    obligations = source.get("components")
    require(type(obligations) is list and len(obligations) == len(identifiers),
            "Every inventoried component needs a resolved source-obligation decision.")
    resolved = set()
    for entry in obligations:
        require(type(entry) is dict and set(entry) == {"id", "requirement", "status", "basis", "evidence"}
                and type(entry["id"]) is str and entry["id"] in identifiers and entry["id"] not in resolved
                and type(entry["basis"]) is str and 20 <= len(entry["basis"].strip()) <= 8192,
                "Source-obligation decision is missing its unique component or reviewed basis.")
        require((entry["requirement"], entry["status"]) in {("none", "not_required"), ("source_required", "fulfilled")},
                "An unresolved source obligation blocks publication.")
        evidence = entry["evidence"]
        require(type(evidence) is list and len(evidence) <= 100
                and (entry["requirement"] == "none" or len(evidence) > 0),
                "Required source needs preserved distribution evidence.")
        for item in evidence:
            require(type(item) is dict and set(item) == {"url", "sha256"}
                    and type(item["url"]) is str and item["url"].startswith("https://")
                    and len(item["url"]) <= 8192 and type(item["sha256"]) is str
                    and re.fullmatch(r"[a-f0-9]{64}", item["sha256"]),
                    "Source distribution evidence needs its reviewed HTTPS URL and exact SHA-256.")
        resolved.add(entry["id"])


def write_materials(destination, content):
    require(destination is not None, "Material preparation requires --destination.")
    require(not any(path.is_symlink() for path in (destination, *destination.parents)),
            "Material destination cannot traverse symbolic links.")
    destination.mkdir(parents=True, exist_ok=True)
    for name in ("BUN-LICENSE.txt", "THIRD-PARTY-NOTICES.txt"):
        path = destination / name
        require(not path.is_symlink() and (not path.exists() or path.is_file()), "Notice destination must be a regular file.")
    for name in ("BUN-LICENSE.txt", "THIRD-PARTY-NOTICES.txt"):
        path = destination / name
        path.write_bytes(content[name])
        path.chmod(0o644)


def context(root, args, environ):
    require(re.fullmatch(r"[a-f0-9]{40}", args.expected_sha or "") is not None,
            "expected_sha must be exactly 40 lowercase hexadecimal characters.")
    require(environ.get("GITHUB_EVENT_NAME") == "workflow_dispatch"
            and environ.get("GITHUB_REF") == "refs/heads/trunk"
            and environ.get("GITHUB_REPOSITORY") == REPOSITORY,
            "Publication requires a workflow_dispatch on this repository's trunk.")
    require(environ.get("GITHUB_SHA") == args.expected_sha
            and environ.get("RELEASE_WORKFLOW_SHA") == args.expected_sha,
            "Dispatch source, workflow source and expected SHA must match exactly.")
    require(environ.get("GITHUB_RUN_ATTEMPT") == "1"
            and re.fullmatch(r"[1-9][0-9]*", environ.get("GITHUB_RUN_ID", "")) is not None,
            "Use a fresh dispatch; rerun attempts cannot reuse prior candidate artifacts.")
    require(git(root, "rev-parse", "HEAD").decode().strip() == args.expected_sha,
            "Checked-out source does not match expected SHA.")
    require(not git(root, "status", "--porcelain", "--untracked-files=no"),
            "Tracked source changed after checkout.")


def validate_candidates(root, directory, materials):
    require(directory is not None and directory.is_dir() and not directory.is_symlink(),
            "All three same-run candidate directories are required.")
    require({path.name for path in directory.iterdir()} == set(TARGETS),
            "Candidate set must contain exactly the three native platform artifacts.")
    assets = {}
    for artifact, (target, executable) in TARGETS.items():
        folder = directory / artifact
        require(folder.is_dir() and not folder.is_symlink(), "Candidate directory is invalid.")
        archive_name = f"fidy-{target}.zip"
        checksum_name = archive_name + ".sha256"
        require({path.name for path in folder.iterdir()} == {archive_name, checksum_name, "install.sh", "install.ps1"},
                "Candidate artifact contains missing or unexpected files.")
        archive = regular_bytes(folder / archive_name, MAX_ARCHIVE)
        checksum = regular_bytes(folder / checksum_name, 1024)
        require(checksum == f"{hashlib.sha256(archive).hexdigest()}  {archive_name}\n".encode(),
                "Candidate checksum does not match the exact archive bytes and name.")
        with zipfile.ZipFile(io.BytesIO(archive)) as package:
            entries = package.infolist()
            require([entry.filename for entry in entries] == [
                executable, "BUN-LICENSE.txt", "THIRD-PARTY-NOTICES.txt"],
                "Each archive must contain exactly its executable and both required notices.")
            require(not package.comment, "Archive comments are not part of the reviewed layout.")
            for entry in entries:
                mode = entry.external_attr >> 16
                limit = MAX_ARCHIVE if entry.filename == executable else MAX_TEXT
                require(entry.create_system == 3 and stat.S_ISREG(mode) and entry.orig_filename == entry.filename
                        and not entry.flag_bits & 1 and entry.compress_type == zipfile.ZIP_STORED
                        and 0 < entry.file_size <= limit and not entry.extra and not entry.comment,
                        "Archive entries must be nonempty regular stored files with bounded metadata.")
                require(stat.S_IMODE(mode) == (0o755 if entry.filename == executable else 0o644),
                        "Archive entry permissions differ from the reviewed layout.")
                data = package.read(entry)
                if entry.filename != executable:
                    require(data == materials[entry.filename], "Packaged notices differ from reviewed materials.")
                elif target == "linux-x64":
                    require(data[:7] == b"\x7fELF\x02\x01\x01" and data[18:20] == b"\x3e\x00",
                            "Linux executable is not x64 ELF.")
                elif target == "darwin-arm64":
                    require(data[:8] == b"\xcf\xfa\xed\xfe\x0c\x00\x00\x01",
                            "macOS executable is not ARM64 Mach-O.")
                else:
                    require(len(data) >= 64 and data[:2] == b"MZ", "Windows executable is not PE.")
                    offset = int.from_bytes(data[60:64], "little")
                    require(data[offset:offset + 6] == b"PE\0\0\x64\x86", "Windows executable is not x64 PE.")
        assets[archive_name], assets[checksum_name] = archive, checksum
        for name in ("install.sh", "install.ps1"):
            installer = regular_bytes(folder / name, MAX_TEXT)
            require(installer == regular_bytes(root / "scripts/cli-release" / name, MAX_TEXT),
                    "Candidate installer differs from trusted checked-out source.")
            assets[name] = installer
    return assets


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, response, code, message, headers, new_url):
        return None


def http_request(method, url, headers, body, limit):
    """One bounded HTTP attempt; redirects and retry decisions belong to the publisher."""
    opener = urllib.request.build_opener(NoRedirect())
    request = urllib.request.Request(url, data=body, headers=headers, method=method)
    try:
        response = opener.open(request, timeout=60)
    except urllib.error.HTTPError as error:
        response = error
    except (OSError, urllib.error.URLError):
        raise ReleaseError("GitHub transport failed; response was not established.") from None
    with response:
        data = response.read(limit + 1)
        require(len(data) <= limit, "GitHub response exceeded its streamed byte limit.")
        return response.status, dict(response.headers), data


def remote_release(args, environ, assets, request, output):
    token = environ.get("GH_TOKEN", "")
    require(bool(token), "The job-scoped GitHub token is missing.")
    api = "https://api.github.com/repos/" + REPOSITORY
    tag = "cli-v" + args.version
    mutation_started = False

    def json_api(method, path, data=None, *, expected=200, missing=False, anonymous=False, upload=None):
        nonlocal mutation_started
        headers = {"Accept": "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28",
                   "User-Agent": "fidy-cli-release"}
        if not anonymous:
            headers["Authorization"] = "Bearer " + token
        body = None
        url = api + path
        if upload is not None:
            url = "https://uploads.github.com/repos/" + REPOSITORY + path
            headers["Content-Type"] = "application/octet-stream"
            body = upload
        elif data is not None:
            headers["Content-Type"] = "application/json"
            body = json.dumps(data).encode()
        if method != "GET":
            mutation_started = True
        try:
            status, _, payload = request(method, url, headers, body, MAX_TEXT)
        except OSError:
            raise ReleaseError("GitHub transport failed; response was not established.") from None
        require(len(payload) <= MAX_TEXT, "GitHub metadata exceeded its byte limit.")
        if missing and status == 404:
            return None
        require(status == expected, f"GitHub returned HTTP {status}; no automatic retry is allowed.")
        try:
            return json.loads(payload)
        except (ValueError, UnicodeError):
            raise ReleaseError("GitHub returned invalid JSON metadata.") from None

    def current_trunk():
        ref = json_api("GET", "/git/ref/heads/trunk")
        require(type(ref) is dict and type(ref.get("object")) is dict
                and ref["object"].get("type") == "commit"
                and ref["object"].get("sha") == args.expected_sha,
                "Trunk changed or its exact commit could not be established.")

    def tag_target(*, absent=False, optional=False, anonymous=False):
        ref = json_api("GET", "/git/ref/tags/" + tag, missing=True, anonymous=anonymous)
        if absent:
            require(ref is None, "Version tag already exists; never overwrite or reuse it.")
        elif not (optional and ref is None):
            require(type(ref) is dict and type(ref.get("object")) is dict
                    and ref["object"].get("type") == "commit"
                    and ref["object"].get("sha") == args.expected_sha,
                    "Release tag does not point directly to the exact expected commit.")

    def release_state(release, draft, release_id=None):
        require(type(release) is dict and type(release.get("id")) is int and release["id"] > 0
                and release.get("tag_name") == tag and release.get("target_commitish") == args.expected_sha
                and release.get("draft") is draft and release.get("prerelease") is False
                and (release_id is None or release["id"] == release_id),
                "Release identity, target or publication state changed unexpectedly.")
        return release["id"]

    def asset_state(item, name):
        require(type(item) is dict and type(item.get("id")) is int and item["id"] > 0
                and item.get("name") == name and item.get("state") == "uploaded"
                and type(item.get("size")) is int and item["size"] == len(assets[name])
                and item.get("digest") == "sha256:" + hashlib.sha256(assets[name]).hexdigest(),
                "Uploaded asset identity, state, size or digest did not match validated bytes.")

    def complete_assets(release_id):
        items = json_api("GET", f"/releases/{release_id}/assets?per_page=100")
        require(type(items) is list and len(items) == len(assets), "Release assets are incomplete or unexpected.")
        require(all(type(item) is dict and type(item.get("name")) is str for item in items)
                and {item["name"] for item in items} == set(assets), "Release asset names are not exact.")
        for item in items:
            asset_state(item, item["name"])
        require(len({item["id"] for item in items}) == len(assets), "Release asset identities are duplicated.")

    def anonymous_bytes(name, data):
        url = f"https://github.com/{REPOSITORY}/releases/download/{tag}/{name}"
        for _ in range(6):
            parsed = urllib.parse.urlsplit(url)
            require(parsed.scheme == "https" and parsed.hostname in {
                "github.com", "release-assets.githubusercontent.com", "objects.githubusercontent.com"
            } and parsed.port in (None, 443) and parsed.username is None and parsed.password is None,
                    "Anonymous asset download redirected outside approved GitHub HTTPS hosts.")
            try:
                status, headers, downloaded = request("GET", url, {"User-Agent": "fidy-cli-release"}, None, len(data))
            except OSError:
                raise ReleaseError("Anonymous download failed; publication is not verified.") from None
            if status in (301, 302, 303, 307, 308):
                location = next((value for key, value in headers.items() if key.lower() == "location"), None)
                require(type(location) is str and len(location) <= 8192, "Anonymous redirect is missing or oversized.")
                url = urllib.parse.urljoin(url, location)
                continue
            require(status == 200 and downloaded == data, "Anonymous asset bytes differ or are unavailable.")
            return
        raise ReleaseError("Anonymous asset redirect limit exceeded.")

    try:
        repository = json_api("GET", "")
        require(type(repository) is dict and repository.get("private") is False
                and repository.get("default_branch") == "trunk",
                "Public distribution requires a public repository with trunk as its default branch.")
        current_trunk()
        tag_target(absent=True)
        # The tag endpoint alone omits drafts. Scan every visible release page, then
        # repeat this check in the write-scoped job so draft visibility is sufficient.
        for page in range(1, 101):
            releases = json_api("GET", f"/releases?per_page=100&page={page}")
            require(type(releases) is list and all(type(item) is dict and type(item.get("tag_name")) is str
                    for item in releases), "Release listing metadata is invalid.")
            require(not any(item["tag_name"] == tag for item in releases),
                    "Version release already exists, including a draft; inspect it manually instead of rerunning.")
            if len(releases) < 100:
                break
        else:
            raise ReleaseError("Release listing exceeded its bounded completeness check.")
        if args.command == "preflight":
            print("Read-only release preflight passed; nothing has been published.", file=output)
            return
        current_trunk()
        tag_target(absent=True)
        release = json_api("POST", "/releases", {
            "tag_name": tag, "target_commitish": args.expected_sha,
            "name": "Fidy CLI " + args.version, "draft": True, "prerelease": False,
            "generate_release_notes": False, "make_latest": "false",
            "body": (f"Fidy CLI {args.version}, source {args.expected_sha}.\n\n"
                     "Native Linux x64, macOS ARM64 and Windows x64 archives, checksums and versioned installers. "
                     "Notices are included. Checksums detect corruption; they are not code signatures. "
                     "Respect operating-system security warnings. No automatic updater is installed."),
        }, expected=201)
        release_id = release_state(release, True)
        initial = json_api("GET", f"/releases/{release_id}/assets?per_page=100")
        require(initial == [], "New draft unexpectedly contains assets; no uploads were attempted.")
        for name in sorted(assets):
            item = json_api("POST", f"/releases/{release_id}/assets?name={urllib.parse.quote(name, safe='')}",
                            expected=201, upload=assets[name])
            asset_state(item, name)
        release_state(json_api("GET", f"/releases/{release_id}"), True, release_id)
        complete_assets(release_id)
        tag_target(optional=True)
        current_trunk()
        release_state(json_api("PATCH", f"/releases/{release_id}", {
            "draft": False, "target_commitish": args.expected_sha, "make_latest": "false"
        }), False, release_id)
        release_state(json_api("GET", f"/releases/{release_id}", anonymous=True), False, release_id)
        tag_target(anonymous=True)
        complete_assets(release_id)
        for name, data in sorted(assets.items()):
            anonymous_bytes(name, data)
        # The tag is checked again after all downloads, not merely before them.
        tag_target(anonymous=True)
        print(f"Published and anonymously verified https://github.com/{REPOSITORY}/releases/tag/{tag}", file=output)
    except (ReleaseError, ValueError, TypeError, KeyError, OSError, KeyboardInterrupt) as error:
        if mutation_started:
            print("Publication may exist, including a partial draft, tag, uploaded assets or a public release. "
                  "Do not rerun or overwrite anything. Inspect GitHub and resolve manually; "
                  "a later invocation refuses existing tags and releases.", file=output)
        if isinstance(error, ReleaseError):
            raise
        raise ReleaseError("Release response or local transport could not be verified.") from None


def main(argv=None, *, source_root=None, environ=None, output=None, request=None):
    output = output or sys.stdout
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=("prepare", "materials", "preflight", "validate", "publish"))
    parser.add_argument("--version", default="0.1.0")
    parser.add_argument("--expected-sha")
    parser.add_argument("--artifacts", type=Path)
    parser.add_argument("--destination", type=Path)
    args = parser.parse_args(argv)
    root = (source_root or Path(__file__).resolve().parents[2]).resolve()
    try:
        if args.command == "prepare":
            print(json.dumps({"source_tree_sha256": source_digest(root),
                              "basis": "Committed HEAD tree, excluding only " + MANIFEST,
                              "status": "Unverified; this command does not approve readiness."}), file=output)
            return 0
        require(re.fullmatch(r"(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)", args.version)
                is not None and args.version == "0.1.0", "Only the reviewed numeric version 0.1.0 is supported.")
        materials = readiness(root, args.version)
        if args.command == "materials":
            write_materials(args.destination, materials)
            print("Prepared both reviewed notice files; no publication occurred.", file=output)
            return 0
        context(root, args, os.environ if environ is None else environ)
        if args.command in ("validate", "publish"):
            assets = validate_candidates(root, args.artifacts, materials)
            print(f"Validated {len(assets)} release assets without executing candidate contents.", file=output)
        if args.command in ("preflight", "publish"):
            remote_release(args, os.environ if environ is None else environ,
                           assets if args.command == "publish" else None, request or http_request, output)
        return 0
    except (ReleaseError, OSError, ValueError, TypeError, KeyError, zipfile.BadZipFile) as error:
        print(str(error) if isinstance(error, ReleaseError) else "Release material could not be read or decoded.", file=output)
        return 1


if __name__ == "__main__":
    sys.exit(main())
