import { Inflate, zipSync } from "fflate";
import { StatementParseFailed, statementParserLimits } from "~/shell/ingestion/contract";

const endSignature = 0x06054b50;
const centralSignature = 0x02014b50;
const localSignature = 0x04034b50;
const endBytes = 22;
const centralBytes = 46;
const localBytes = 30;
const maximumEntries = 1_000;
const inputChunkBytes = 1024;
const maximumCommentBytes = 65_535;
const deflated = 8;
const encryptedFlag = 1;
const maximumZip32Size = 0xffffffff;
const endCommentLengthOffset = 20;
const endCountOffset = 10;
const endDiskCountOffset = 8;
const endDirectoryOffset = 16;
const endDirectorySizeOffset = 12;
const centralMethodOffset = 10;
const centralFlagsOffset = 8;
const centralCompressedSizeOffset = 20;
const centralExpandedSizeOffset = 24;
const centralNameLengthOffset = 28;
const centralExtraLengthOffset = 30;
const centralCommentLengthOffset = 32;
const centralLocalOffset = 42;
const localNameLengthOffset = 26;
const localExtraLengthOffset = 28;
const localMethodOffset = 8;
const localFlagsOffset = 6;
const decoder = new TextDecoder("utf-8", { fatal: true });

const malformed = (): never => {
  throw new StatementParseFailed({ safeReason: "malformed-file" });
};
const resourceLimit = (): never => {
  throw new StatementParseFailed({ safeReason: "resource-limit" });
};

const endOffset = (view: DataView): number => {
  for (
    let offset = view.byteLength - endBytes;
    offset >= Math.max(0, view.byteLength - endBytes - maximumCommentBytes);
    offset -= 1
  ) {
    if (
      view.getUint32(offset, true) === endSignature &&
      offset + endBytes + view.getUint16(offset + endCommentLengthOffset, true) === view.byteLength
    ) {
      return offset;
    }
  }
  return malformed();
};

const expand = (compressed: Uint8Array, method: number, remaining: number): Uint8Array => {
  if (method === 0) {
    if (compressed.length > remaining) resourceLimit();
    return compressed;
  }
  if (method !== deflated) return malformed();
  const chunks: Array<Uint8Array> = [];
  let length = 0;
  const inflater = new Inflate((chunk) => {
    length += chunk.length;
    if (length > remaining) resourceLimit();
    chunks.push(chunk);
  });
  for (let offset = 0; offset < compressed.length; offset += inputChunkBytes) {
    const end = Math.min(offset + inputChunkBytes, compressed.length);
    inflater.push(compressed.subarray(offset, end), end === compressed.length);
  }
  if (compressed.length === 0) inflater.push(compressed, true);
  const output = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.length;
  }
  return output;
};

type Entry = Readonly<{ name: string; bytes: Uint8Array; next: number }>;

const assertLocalEntry = (
  input: Readonly<{
    name: string;
    localName: string;
    method: number;
    flags: number;
    view: DataView;
    local: number;
  }>
): void => {
  if (input.name !== input.localName) return malformed();
  if (input.method !== input.view.getUint16(input.local + localMethodOffset, true)) {
    return malformed();
  }
  if (input.flags !== input.view.getUint16(input.local + localFlagsOffset, true)) {
    return malformed();
  }
};
const unsafeName = (name: string): boolean =>
  name.includes("..") || name.startsWith("/") || name.includes("\\");
const directory = (view: DataView, end: number): Readonly<{ count: number; start: number }> => {
  const count = view.getUint16(end + endCountOffset, true);
  if (count > maximumEntries) resourceLimit();
  if (
    count === 0 ||
    view.getUint32(end + 4, true) !== 0 ||
    view.getUint16(end + endDiskCountOffset, true) !== count
  ) {
    return malformed();
  }
  const start = view.getUint32(end + endDirectoryOffset, true);
  if (start + view.getUint32(end + endDirectorySizeOffset, true) !== end) return malformed();
  return { count, start };
};

type EntryInput = Readonly<{
  bytes: Uint8Array;
  view: DataView;
  offset: number;
  remaining: number;
}>;
const assertHeader = (
  view: DataView,
  input: Readonly<{ offset: number; bytes: number; signature: number }>
): void => {
  if (input.offset + input.bytes > view.byteLength) return malformed();
  if (view.getUint32(input.offset, true) !== input.signature) return malformed();
};
const assertZip32 = (compressed: number, expanded: number): void => {
  if (compressed === maximumZip32Size || expanded === maximumZip32Size) return malformed();
};
const decodeEntry = ({ bytes, view, offset, remaining }: EntryInput): Entry => {
  assertHeader(view, { offset, bytes: centralBytes, signature: centralSignature });
  const method = view.getUint16(offset + centralMethodOffset, true);
  const flags = view.getUint16(offset + centralFlagsOffset, true);
  const compressedSize = view.getUint32(offset + centralCompressedSizeOffset, true);
  const expandedSize = view.getUint32(offset + centralExpandedSizeOffset, true);
  const nameLength = view.getUint16(offset + centralNameLengthOffset, true);
  const extraLength = view.getUint16(offset + centralExtraLengthOffset, true);
  const commentLength = view.getUint16(offset + centralCommentLengthOffset, true);
  const local = view.getUint32(offset + centralLocalOffset, true);
  const next = offset + centralBytes + nameLength + extraLength + commentLength;
  // ZIP64 and encrypted members have no admitted representation in this policy.
  assertZip32(compressedSize, expandedSize);
  if ((flags & encryptedFlag) !== 0 || next > bytes.length) return malformed();
  assertHeader(view, { offset: local, bytes: localBytes, signature: localSignature });
  const localNameLength = view.getUint16(local + localNameLengthOffset, true);
  const localExtraLength = view.getUint16(local + localExtraLengthOffset, true);
  const data = local + localBytes + localNameLength + localExtraLength;
  const name = decoder.decode(
    bytes.subarray(offset + centralBytes, offset + centralBytes + nameLength)
  );
  const localName = decoder.decode(
    bytes.subarray(local + localBytes, local + localBytes + localNameLength)
  );
  assertLocalEntry({ name, localName, method, flags, view, local });
  if (data + compressedSize > offset) return malformed();
  const expanded = expand(bytes.subarray(data, data + compressedSize), method, remaining);
  if (expanded.length !== expandedSize) return malformed();
  return { name, bytes: expanded, next };
};

/** Decode actual members under the expansion ceiling; canonical output prevents library ZIP disagreement. */
export const decodeXlsxArchive = (bytes: Uint8Array): Map<string, Uint8Array> => {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const end = endOffset(view);
  const { count, start } = directory(view, end);
  let offset = start;
  const entries = new Map<string, Uint8Array>();
  const names = new Set<string>();
  let expanded = 0;
  for (let index = 0; index < count; index += 1) {
    const entry = decodeEntry({
      bytes,
      view,
      offset,
      remaining: statementParserLimits.maximumExpandedBytes - expanded,
    });
    const key = entry.name.toLowerCase();
    if (names.has(key) || unsafeName(key)) return malformed();
    names.add(key);
    entries.set(entry.name, entry.bytes);
    expanded += entry.bytes.length;
    offset = entry.next;
  }
  if (offset !== end) return malformed();
  return entries;
};

/** Preserve admitted members in an unambiguous stored ZIP consumed by SheetJS. */
export const encodeXlsxArchive = (entries: Map<string, Uint8Array>): Uint8Array =>
  zipSync(Object.fromEntries(entries), { level: 0 });
