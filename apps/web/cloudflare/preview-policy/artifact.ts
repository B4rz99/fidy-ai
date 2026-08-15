#!/usr/bin/env bun

import { lstat, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join } from "node:path";
import { isRecord, requireArgument } from "./shared";

const KIBIBYTE = 1024;
const MEBIBYTE = KIBIBYTE * KIBIBYTE;
export const MAX_FILES = 512;
const MAX_FILE_MEBIBYTES = 16;
const MAX_TOTAL_MEBIBYTES = 64;
const MAX_FILE_BYTES = MAX_FILE_MEBIBYTES * MEBIBYTE;
const MAX_TOTAL_BYTES = MAX_TOTAL_MEBIBYTES * MEBIBYTE;
const TAR_BLOCK_BYTES = 512;
const MAX_ARCHIVE_BYTES = MAX_TOTAL_BYTES + (MAX_FILES + 2) * TAR_BLOCK_BYTES * 2;
const ASCII_SPACE = 0x20;
const ASCII_ZERO = 0x30;
const ASCII_UPPER_A = 0x41;
const ASCII_UPPER_Z = 0x5a;
const CHECKSUM_START = 148;
const CHECKSUM_END = 156;
const REQUIRED_PATHS = new Set(["_headers", "index.html", "preview-metadata.json"]);
const ASSET_SUFFIXES = new Set([
  ".avif",
  ".css",
  ".gif",
  ".ico",
  ".jpeg",
  ".jpg",
  ".js",
  ".otf",
  ".png",
  ".svg",
  ".ttf",
  ".webp",
  ".woff",
  ".woff2",
]);
const FORBIDDEN_BASENAMES = new Set([
  "_worker.js",
  "server.js",
  "server.mjs",
  "service-worker.js",
  "sw.js",
  "worker.js",
  "worker.mjs",
  "wrangler.json",
  "wrangler.jsonc",
  "wrangler.toml",
]);
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });
const FORBIDDEN_CONTENT_STRINGS = [
  "BEGIN PRIVATE KEY",
  "CLOUDFLARE_API_TOKEN",
  "DATABASE_URL",
  "MIGRATION_DATABASE_URL",
  "RAILWAY_TOKEN",
  "/apps/server/src/",
  "node_modules/@effect/sql-pg",
  "https://api.fidyapp.com",
];

type TarField = {
  readonly offset: number;
  readonly length: number;
};

type TarEntry = {
  readonly path: string;
  readonly size: number;
};

type ValidatedFile = {
  readonly path: string;
  readonly contents: Uint8Array;
};

export type PreviewArtifactRequest = {
  readonly archivePath: string;
  readonly outputDirectory: string;
  readonly expectedSha: string;
  readonly expectedDigest: string;
  readonly trustedHeadersPath: string;
};

const TAR_NAME = { offset: 0, length: 100 } satisfies TarField;
const TAR_SIZE = { offset: 124, length: 12 } satisfies TarField;
const TAR_CHECKSUM = { offset: CHECKSUM_START, length: 8 } satisfies TarField;
const TAR_TYPE = 156;
const TAR_MAGIC = { offset: 257, length: 6 } satisfies TarField;
const TAR_PREFIX = { offset: 345, length: 155 } satisfies TarField;

const byteAt = (bytes: Uint8Array, index: number): number => {
  const byte = bytes[index];
  if (byte === undefined) throw new Error("preview artifact ended unexpectedly");
  return byte;
};

const allZero = (bytes: Uint8Array): boolean => bytes.every((byte) => byte === 0);

const bytesEqual = (left: Uint8Array, right: Uint8Array): boolean =>
  left.length === right.length && left.every((byte, index) => byte === right[index]);

const includesAsciiIgnoringCase = (contents: Uint8Array, marker: string): boolean => {
  const expected = encoder.encode(marker.toLowerCase());
  const limit = contents.length - expected.length;
  for (let offset = 0; offset <= limit; offset += 1) {
    let matches = true;
    for (let index = 0; index < expected.length; index += 1) {
      const byte = byteAt(contents, offset + index);
      const lowercase = byte >= ASCII_UPPER_A && byte <= ASCII_UPPER_Z ? byte + ASCII_SPACE : byte;
      if (lowercase !== expected[index]) {
        matches = false;
        break;
      }
    }
    if (matches) return true;
  }
  return false;
};

const tarString = (header: Uint8Array, field: TarField): string => {
  const bytes = header.subarray(field.offset, field.offset + field.length);
  const terminator = bytes.indexOf(0);
  const end = terminator === -1 ? bytes.length : terminator;
  if (terminator !== -1 && !allZero(bytes.subarray(terminator))) {
    throw new Error("preview artifact contains a malformed tar string");
  }
  return decoder.decode(bytes.subarray(0, end));
};

const tarNumber = (header: Uint8Array, field: TarField): number => {
  const bytes = header.subarray(field.offset, field.offset + field.length);
  const rendered = decoder
    .decode(bytes)
    .replace(/[\0 ]+$/u, "")
    .replace(/^ +/u, "");
  if (!/^[0-7]+$/u.test(rendered)) {
    throw new Error("preview artifact contains a malformed tar number");
  }
  const value = Number.parseInt(rendered, 8);
  if (!Number.isSafeInteger(value)) throw new Error("preview artifact tar number is too large");
  return value;
};

const tarChecksum = (header: Uint8Array): number => {
  let checksum = 0;
  for (let index = 0; index < header.length; index += 1) {
    checksum +=
      index >= CHECKSUM_START && index < CHECKSUM_END ? ASCII_SPACE : byteAt(header, index);
  }
  return checksum;
};

const checkedTarHeader = (header: Uint8Array): TarEntry => {
  if (tarChecksum(header) !== tarNumber(header, TAR_CHECKSUM)) {
    throw new Error("preview artifact contains an invalid tar checksum");
  }
  if (tarString(header, TAR_MAGIC) !== "ustar") {
    throw new Error("preview artifact is not a supported uncompressed tar archive");
  }
  const type = byteAt(header, TAR_TYPE);
  if (type !== 0 && type !== ASCII_ZERO) {
    throw new Error("artifact entry is not a regular file");
  }
  const name = tarString(header, TAR_NAME);
  const prefix = tarString(header, TAR_PREFIX);
  return {
    path: prefix === "" ? name : `${prefix}/${name}`,
    size: tarNumber(header, TAR_SIZE),
  };
};

const safePath = (path: string): string => {
  const parts = path.split("/");
  const unsafePart = parts.some((part) => part === "" || part === "." || part === "..");
  if (path === "" || path.startsWith("/") || path.includes("\\") || path.includes("\0")) {
    throw new Error(`unsafe archive path: ${JSON.stringify(path)}`);
  }
  if (unsafePart) throw new Error(`unsafe archive path: ${JSON.stringify(path)}`);
  return path;
};

const allowedPath = (path: string): boolean => {
  if (REQUIRED_PATHS.has(path)) return true;
  const parts = path.split("/");
  return (
    parts.length >= 2 && parts[0] === "assets" && ASSET_SUFFIXES.has(extname(path).toLowerCase())
  );
};

const validateMetadata = (
  contents: Uint8Array,
  request: Pick<PreviewArtifactRequest, "expectedSha" | "expectedDigest">
): void => {
  let metadata: unknown;
  try {
    metadata = JSON.parse(decoder.decode(contents));
  } catch {
    throw new Error("preview metadata is not valid JSON");
  }
  if (!isRecord(metadata)) {
    throw new Error("preview metadata does not match the expected head SHA and digest");
  }
  if (
    Object.keys(metadata).length !== 2 ||
    metadata.gitRevision !== request.expectedSha ||
    metadata.contractDigest !== request.expectedDigest
  ) {
    throw new Error("preview metadata does not match the expected head SHA and digest");
  }
};

const validatedPath = (entry: TarEntry, files: ReadonlyMap<string, Uint8Array>): string => {
  const path = safePath(entry.path);
  if (files.has(path)) throw new Error(`duplicate artifact path: ${path}`);
  const filename = basename(path).toLowerCase();
  if (!allowedPath(path) || FORBIDDEN_BASENAMES.has(filename)) {
    throw new Error(`forbidden artifact path: ${path}`);
  }
  if (extname(path).toLowerCase() === ".map" || filename.includes("server")) {
    throw new Error(`forbidden artifact path: ${path}`);
  }
  if (entry.size > MAX_FILE_BYTES) throw new Error(`artifact file is too large: ${path}`);
  return path;
};

const looksLikeSourceMap = (contents: Uint8Array): boolean => {
  let value: unknown;
  try {
    value = JSON.parse(decoder.decode(contents));
  } catch {
    return false;
  }
  if (!isRecord(value) || value.version !== 3) return false;
  const flatSourceMap = Array.isArray(value.sources) && typeof value.mappings === "string";
  return flatSourceMap || Array.isArray(value.sections);
};

const validateContents = (path: string, contents: Uint8Array): void => {
  if (FORBIDDEN_CONTENT_STRINGS.some((marker) => includesAsciiIgnoringCase(contents, marker))) {
    throw new Error(`forbidden server, Secret, or Production material: ${path}`);
  }
  if (includesAsciiIgnoringCase(contents, "sourcemappingurl=") || looksLikeSourceMap(contents)) {
    throw new Error(`forbidden source-map material: ${path}`);
  }
};

const validateEntry = (
  entry: TarEntry,
  contents: Uint8Array,
  files: ReadonlyMap<string, Uint8Array>
): ValidatedFile => {
  const path = validatedPath(entry, files);
  validateContents(path, contents);
  return { contents, path };
};

const tarContents = (
  archive: Uint8Array,
  offset: number,
  entry: TarEntry
): { readonly contents: Uint8Array; readonly nextOffset: number } => {
  const contentStart = offset + TAR_BLOCK_BYTES;
  const contentEnd = contentStart + entry.size;
  const nextOffset = contentStart + Math.ceil(entry.size / TAR_BLOCK_BYTES) * TAR_BLOCK_BYTES;
  if (contentEnd > archive.length || nextOffset > archive.length) {
    throw new Error(`artifact file could not be read: ${entry.path}`);
  }
  return { contents: archive.slice(contentStart, contentEnd), nextOffset };
};

const assertTarTerminator = (archive: Uint8Array, offset: number): void => {
  const second = archive.subarray(offset + TAR_BLOCK_BYTES, offset + TAR_BLOCK_BYTES * 2);
  if (second.length !== TAR_BLOCK_BYTES || !allZero(second)) {
    throw new Error("preview artifact has an invalid tar terminator");
  }
  if (!allZero(archive.subarray(offset + TAR_BLOCK_BYTES * 2))) {
    throw new Error("preview artifact has data after its tar terminator");
  }
};

const parseArchive = (archive: Uint8Array): ReadonlyMap<string, Uint8Array> => {
  const files = new Map<string, Uint8Array>();
  let offset = 0;
  let totalSize = 0;
  while (offset + TAR_BLOCK_BYTES <= archive.length) {
    const header = archive.subarray(offset, offset + TAR_BLOCK_BYTES);
    if (allZero(header)) {
      assertTarTerminator(archive, offset);
      return files;
    }
    if (files.size >= MAX_FILES) throw new Error("preview artifact contains too many entries");
    const entry = checkedTarHeader(header);
    const { contents, nextOffset } = tarContents(archive, offset, entry);
    const file = validateEntry(entry, contents, files);
    totalSize += entry.size;
    if (totalSize > MAX_TOTAL_BYTES) throw new Error("preview artifact is too large");
    files.set(file.path, file.contents);
    offset = nextOffset;
  }
  throw new Error("preview artifact is not a complete uncompressed tar archive");
};

const requiredFile = (files: ReadonlyMap<string, Uint8Array>, path: string): Uint8Array => {
  const contents = files.get(path);
  if (contents === undefined) throw new Error(`preview artifact is missing required file: ${path}`);
  return contents;
};

const readValidatedFiles = async (
  request: PreviewArtifactRequest
): Promise<ReadonlyArray<ValidatedFile>> => {
  const archiveStats = await lstat(request.archivePath);
  if (!archiveStats.isFile() || archiveStats.isSymbolicLink()) {
    throw new Error("preview archive must be one regular file");
  }
  if (archiveStats.size > MAX_ARCHIVE_BYTES) throw new Error("preview artifact is too large");
  if (!/^[0-9a-f]{40}$/u.test(request.expectedSha)) {
    throw new Error("expected head SHA must be 40 lowercase hexadecimal characters");
  }
  if (!/^[0-9a-f]{64}$/u.test(request.expectedDigest)) {
    throw new Error("expected contract digest must be 64 lowercase hexadecimal characters");
  }

  const files = parseArchive(new Uint8Array(await readFile(request.archivePath)));
  const missing = [...REQUIRED_PATHS].filter((path) => !files.has(path));
  if (missing.length > 0) {
    throw new Error(`preview artifact is missing required files: ${missing.sort().join(", ")}`);
  }
  if (
    !bytesEqual(
      requiredFile(files, "_headers"),
      new Uint8Array(await readFile(request.trustedHeadersPath))
    )
  ) {
    throw new Error("preview headers do not match trusted base-branch policy");
  }
  validateMetadata(requiredFile(files, "preview-metadata.json"), request);
  return [...files].map(([path, contents]) => ({ contents, path }));
};

type ErrorWithCode = Error & { readonly code: string };

const hasErrorCode = (error: unknown): error is ErrorWithCode =>
  error instanceof Error && "code" in error && typeof error.code === "string";

const pathExists = async (path: string): Promise<boolean> => {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (hasErrorCode(error) && error.code === "ENOENT") return false;
    throw error;
  }
};

/**
 * Validates one bounded static tarball against trusted identity and header policy, then atomically
 * creates a previously absent output directory. Policy, archive, filesystem, and existing-output
 * failures leave that output path unexposed.
 */
export const validateAndExtract = async (request: PreviewArtifactRequest): Promise<void> => {
  const files = await readValidatedFiles(request);
  const outputParent = dirname(request.outputDirectory);
  await mkdir(outputParent, { recursive: true });
  const temporary = await mkdtemp(join(outputParent, `.${basename(request.outputDirectory)}-`));
  try {
    await Promise.all(
      files.map(async (file) => {
        const target = join(temporary, ...file.path.split("/"));
        await mkdir(dirname(target), { recursive: true });
        await writeFile(target, file.contents);
      })
    );
    if (await pathExists(request.outputDirectory)) {
      throw new Error("preview output directory already exists");
    }
    await rename(temporary, request.outputDirectory);
  } finally {
    await rm(temporary, { force: true, recursive: true });
  }
};

if (import.meta.main) {
  await validateAndExtract({
    archivePath: requireArgument("archive"),
    expectedDigest: requireArgument("expected-digest"),
    expectedSha: requireArgument("expected-sha"),
    outputDirectory: requireArgument("output"),
    trustedHeadersPath: requireArgument("trusted-headers"),
  });
}
