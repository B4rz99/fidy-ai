#!/usr/bin/env python3
"""Validate a source packet against a trusted reviewed specification, without extraction.

The caller supplies specification bytes from its exact checkout and release context.
Origins describe provenance only; this module has no network or execution capability.
"""
import hashlib
import json
from pathlib import Path
import re
import struct
import tarfile
import unicodedata
import zlib

MAX_SPEC = 8 * 1024 * 1024
MAX_COMPRESSED = 128 * 1024 * 1024
MAX_FILE = 16 * 1024 * 1024
MAX_TOTAL = 512 * 1024 * 1024
MAX_ENTRIES = 20000
CHUNK = 65536
GZIP_HEADER = bytes.fromhex("1f8b08000000000002ff")
RELEASE_METADATA = "SOURCE-RELEASE.json"


class SourceError(Exception):
    """A source-distribution contract violation, safe to show in release logs."""


def require(condition, message):
    if not condition:
        raise SourceError(message)


def unique_object(pairs):
    result = {}
    for key, value in pairs:
        require(key not in result, "Source specification contains duplicate JSON keys.")
        result[key] = value
    return result


def canonical_json(value):
    return (json.dumps(value, sort_keys=True, indent=2, ensure_ascii=True) + "\n").encode("utf-8")


def canonical_path(value):
    require(type(value) is str and 0 < len(value.encode("utf-8")) <= 255,
            "Source member path is missing or exceeds USTAR limits.")
    require(unicodedata.normalize("NFC", value) == value
            and not any(ord(char) < 32 or ord(char) == 127 or char in "\\:" for char in value),
            "Source member path contains noncanonical characters.")
    parts = value.split("/")
    require(all(part not in ("", ".", "..") and not part.endswith((".", " ")) for part in parts),
            "Source member path is absolute, traversing or aliased.")
    reserved = {"con", "prn", "aux", "nul", *(f"com{i}" for i in range(1, 10)), *(f"lpt{i}" for i in range(1, 10))}
    require(all(part.split(".", 1)[0].casefold() not in reserved for part in parts),
            "Source member path aliases a reserved recipient filename.")
    return value


def hexadecimal(value, length):
    return type(value) is str and re.fullmatch(r"[a-f0-9]{" + str(length) + "}", value) is not None


def canonical_header(entry):
    """Return the sole allowed USTAR header for one validated regular source entry."""
    info = tarfile.TarInfo(entry["path"])
    info.mode = entry["mode"]
    info.uid = info.gid = info.mtime = 0
    info.uname = info.gname = ""
    info.size = entry["bytes"]
    info.type = tarfile.REGTYPE
    try:
        return info.tobuf(format=tarfile.USTAR_FORMAT, encoding="utf-8", errors="strict")
    except (ValueError, UnicodeError):
        raise SourceError("Source member path cannot be represented by canonical USTAR.") from None


def specification(raw, *, cli_version, bun_revision, source_commit):
    """Decode the trusted specification and derive the exact dynamic release record."""
    require(type(raw) is bytes and 0 < len(raw) <= MAX_SPEC, "Source specification exceeds its byte limit.")
    try:
        spec = json.loads(raw.decode("utf-8"), object_pairs_hook=unique_object)
    except (ValueError, UnicodeError):
        raise SourceError("Source specification is not valid UTF-8 JSON.") from None
    require(type(spec) is dict and set(spec) == {"schema_version", "cli_version", "bun_revision", "files"}
            and type(spec["schema_version"]) is int and spec["schema_version"] == 1,
            "Source specification schema is unsupported or has unexpected fields.")
    require(spec["cli_version"] == cli_version == "0.1.0" and spec["bun_revision"] == bun_revision
            and hexadecimal(bun_revision, 40) and hexadecimal(source_commit, 40),
            "Source specification does not match the exact CLI, runtime or source revision.")
    files = spec["files"]
    require(type(files) is list and 0 < len(files) < MAX_ENTRIES,
            "Source specification entry count is outside the reviewed limit.")
    paths, folded_paths, prefix_paths = [], set(), set()
    entries = []
    for entry in files:
        require(type(entry) is dict and set(entry) == {"path", "mode", "bytes", "sha256", "origin"},
                "Source file record fields are missing or unexpected.")
        path = canonical_path(entry["path"])
        require(path.casefold() != RELEASE_METADATA.casefold(), "Source specification cannot supply release metadata.")
        require(type(entry["mode"]) is int and entry["mode"] in (0o644, 0o755)
                and type(entry["bytes"]) is int and 0 <= entry["bytes"] <= MAX_FILE
                and hexadecimal(entry["sha256"], 64), "Source file mode, size or digest is invalid.")
        origin = entry["origin"]
        require(type(origin) is dict and type(origin.get("kind")) is str, "Source origin schema is missing.")
        if origin["kind"] == "git":
            require(set(origin) == {"kind", "repository", "revision", "path", "git_blob_sha1"}
                    and type(origin["repository"]) is str and re.fullmatch(
                        r"[A-Za-z0-9][A-Za-z0-9_.-]*/[A-Za-z0-9][A-Za-z0-9_.-]*", origin["repository"])
                    and hexadecimal(origin["revision"], 40) and hexadecimal(origin["git_blob_sha1"], 40),
                    "Immutable Git source origin is incomplete or invalid.")
            canonical_path(origin["path"])
        elif origin["kind"] == "checkout":
            require(set(origin) == {"kind", "path", "git_blob_sha1"} and hexadecimal(origin["git_blob_sha1"], 40),
                    "Checked-out source origin is incomplete or invalid.")
            canonical_path(origin["path"])
        elif origin["kind"] == "generated":
            require(origin in ({"kind": "generated", "generator": "bun-build", "label": "application-payload"},
                               {"kind": "generated", "generator": "source-index", "label": "recipient-index"}),
                    "Generated source origin is not a reviewed payload or recipient index.")
        else:
            raise SourceError("Unknown source origin kind.")
        paths.append(path)
        entries.append(dict(entry))
    require(paths == sorted(paths) and len(set(paths)) == len(paths), "Source specification files must be unique and sorted.")
    metadata = source_metadata(cli_version, bun_revision, source_commit)
    entries.append({"path": RELEASE_METADATA, "mode": 0o644, "bytes": len(metadata),
                    "sha256": hashlib.sha256(metadata).hexdigest()})
    entries.sort(key=lambda entry: entry["path"])
    tar_bytes = 1024
    for entry in entries:
        folded = entry["path"].casefold()
        prefixes = {folded[:match.start()] for match in re.finditer("/", folded)}
        require(folded not in folded_paths and folded not in prefix_paths and not prefixes.intersection(folded_paths),
                "Source member paths contain a case-fold or file/directory collision.")
        folded_paths.add(folded)
        prefix_paths.update(prefixes)
        canonical_header(entry)
        tar_bytes += 512 + ((entry["bytes"] + 511) // 512) * 512
    require(tar_bytes <= MAX_TOTAL, "Source archive exceeds the total uncompressed limit.")
    return entries



def source_metadata(version, bun_revision, source_commit):
    """Return canonical SOURCE-RELEASE.json bytes bound to the exact trusted source."""
    require(version == "0.1.0" and hexadecimal(bun_revision, 40) and hexadecimal(source_commit, 40),
            "Source release metadata needs exact version, runtime and commit identities.")
    return canonical_json({"schema_version": 1, "cli_version": version,
                           "bun_revision": bun_revision, "source_commit": source_commit})


def spec_decode(data, version, bun_revision):
    """Return a strict reviewed source spec, without the dynamic metadata member."""
    entries = specification(data, cli_version=version, bun_revision=bun_revision, source_commit="0" * 40)
    return {"schema_version": 1, "cli_version": version, "bun_revision": bun_revision,
            "files": [entry for entry in entries if entry["path"] != RELEASE_METADATA]}


def gzip_chunks(archive):
    require(18 <= len(archive) <= MAX_COMPRESSED and archive[:10] == GZIP_HEADER,
            "Source gzip header or compressed size is not canonical.")
    decompressor = zlib.decompressobj(-zlib.MAX_WBITS)
    compressed = memoryview(archive)[10:-8]
    cursor, total, crc = 0, 0, 0
    pending = b""
    try:
        while cursor < len(compressed) or pending:
            if not pending:
                pending = compressed[cursor:cursor + CHUNK]
                cursor += len(pending)
            block = decompressor.decompress(pending, min(CHUNK, MAX_TOTAL - total + 1))
            pending = decompressor.unconsumed_tail
            total += len(block)
            require(total <= MAX_TOTAL, "Source gzip exceeded the uncompressed byte limit.")
            crc = zlib.crc32(block, crc)
            require(not decompressor.unused_data, "Source gzip contains trailing or concatenated data.")
            if block:
                yield block
            if decompressor.eof:
                require(cursor == len(compressed) and not pending, "Source gzip contains trailing or concatenated data.")
                break
        require(decompressor.eof, "Source gzip stream is truncated.")
    except zlib.error:
        raise SourceError("Source gzip stream is invalid.") from None
    require(archive[-8:] == struct.pack("<II", crc & 0xffffffff, total & 0xffffffff),
            "Source gzip trailer checksum or size is invalid.")


def validate_archive(archive, entries):
    chunks = iter(gzip_chunks(archive))
    buffer = bytearray()

    def read_exact(size):
        while len(buffer) < size:
            try:
                buffer.extend(next(chunks))
            except StopIteration:
                raise SourceError("Source tar stream ended before its expected content.") from None
        result = bytes(buffer[:size])
        del buffer[:size]
        return result

    for entry in entries:
        require(read_exact(512) == canonical_header(entry),
                "Source tar header, order, path or member type differs from the trusted specification.")
        digest = hashlib.sha256()
        blob = hashlib.sha1(f"blob {entry['bytes']}\0".encode("ascii"))
        remaining = entry["bytes"]
        while remaining:
            block = read_exact(min(CHUNK, remaining))
            digest.update(block)
            blob.update(block)
            remaining -= len(block)
        require(digest.hexdigest() == entry["sha256"], "Source member bytes differ from the trusted specification.")
        origin = entry.get("origin", {})
        if origin.get("kind") in ("git", "checkout"):
            require(blob.hexdigest() == origin["git_blob_sha1"], "Source member does not match its immutable Git blob identity.")
        padding = (-entry["bytes"]) % 512
        require(read_exact(padding) == bytes(padding), "Source tar member padding is nonzero.")
    require(read_exact(1024) == bytes(1024), "Source tar must end with exactly two zero blocks.")
    require(not buffer, "Source tar has trailing records or padding.")
    try:
        next(chunks)
    except StopIteration:
        return
    raise SourceError("Source tar has trailing records or padding.")


def file_bytes(path, limit):
    require(path.is_file() and not path.is_symlink() and 0 < path.stat().st_size <= limit,
            "Source artifact must be a nonempty bounded regular file.")
    with path.open("rb") as stream:
        data = stream.read(limit + 1)
    require(0 < len(data) <= limit, "Source artifact exceeded its streamed byte limit.")
    return data


def validate_artifact(directory, raw_spec, *, cli_version, bun_revision, source_commit):
    """Return exactly the validated source archive and sidecar, with no filesystem writes."""
    require(isinstance(directory, Path) and directory.is_dir() and not directory.is_symlink(),
            "A separate same-run cli-source artifact directory is required.")
    name = f"fidy-cli-v{cli_version}-source.tar.gz"
    checksum_name = name + ".sha256"
    require({path.name for path in directory.iterdir()} == {name, checksum_name, "source-spec.json"},
            "Source artifact must contain exactly the versioned archive, checksum and generated manifest.")
    require(file_bytes(directory / "source-spec.json", MAX_SPEC) == raw_spec,
            "Source artifact manifest differs from the independently trusted specification.")
    entries = specification(raw_spec, cli_version=cli_version, bun_revision=bun_revision, source_commit=source_commit)
    archive = file_bytes(directory / name, MAX_COMPRESSED)
    checksum = file_bytes(directory / checksum_name, 1024)
    require(checksum == f"{hashlib.sha256(archive).hexdigest()}  {name}\n".encode("ascii"),
            "Source archive checksum does not match its exact bytes and name.")
    validate_archive(archive, entries)
    return {name: archive, checksum_name: checksum}
