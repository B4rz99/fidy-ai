import {
  maximumMaterializedHeaderBytes,
  maximumMaterializedStatementBytes,
} from "./statement-processing-limits";
import { Option } from "effect";
import type {
  NeedsReviewStatementRow,
  ParsedStatementRow,
  StatementRowEvidence,
  XlsxCellEvidence,
} from "../../../src/core/ingestion/contract";

// D1's limit is decimal bytes and covers the encoded table record, not evidence alone.
const maximumRowBytes = 2_000_000;
const overBudget = maximumRowBytes + 1;
const uuidBytes = 36;
const textSerialBase = 13;
const varintBase = 128;
const surrogateStart = 0xd800;
const lowSurrogateStart = 0xdc00;
const surrogateEnd = 0xdfff;
const asciiEnd = 0x7f;
const twoByteEnd = 0x7ff;
const firstUnescapedControl = 0x20;
const quote = 0x22;
const backslash = 0x5c;
const unicodeEscapeBytes = 6;
const shortEscapes = new Set(Array.from("\b\t\n\f\r", (value) => value.charCodeAt(0)));
const sixByteInteger = 6;
const eightByteInteger = 8;

type EncodedMember = readonly [name: string, bytes: number];
type StoredValue = Readonly<{ bytes: number; serial: number }>;
type ReviewContext = Readonly<{
  userId: string;
  submissionId: string;
  serviceMarket: string;
  locale: string;
  timeZone: string;
  sourceFormat: "csv" | "xlsx";
  parserRevision: string;
  extractorRevision: string;
  expiresAt: number;
  createdAt: number;
}>;

const jsonEscapeBytes = (unit: number): number => {
  if (unit === quote || unit === backslash || shortEscapes.has(unit)) return 2;
  return unit < firstUnescapedControl ? unicodeEscapeBytes : 0;
};

const surrogateBytes = (unit: number, next: number, json: boolean): number => {
  if (unit < surrogateStart || unit > surrogateEnd) return 3;
  if (unit < lowSurrogateStart && next >= lowSurrogateStart && next <= surrogateEnd) return 4;
  return json ? unicodeEscapeBytes : 3;
};

const utf8Bytes = (unit: number, next: number, json: boolean): number => {
  if (unit <= asciiEnd) return 1;
  if (unit <= twoByteEnd) return 2;
  return surrogateBytes(unit, next, json);
};

const stringBytes = (value: string, json: boolean, maximum = maximumRowBytes): number => {
  let bytes = json ? 2 : 0;
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    const escaped = json ? jsonEscapeBytes(unit) : 0;
    const width = escaped || utf8Bytes(unit, value.charCodeAt(index + 1), json);
    bytes += width;
    if (width === 4) index += 1;
    if (bytes > maximum) return maximum + 1;
  }
  return bytes;
};

const objectBytes = (members: ReadonlyArray<EncodedMember>): number =>
  2 +
  Math.max(0, members.length - 1) +
  members.reduce((sum, [key, size]) => sum + key.length + 3 + size, 0);

const arrayBytes = <A>(
  values: ReadonlyArray<A>,
  size: (value: A) => number,
  maximum = maximumRowBytes
): number => {
  let bytes = 2 + Math.max(0, values.length - 1);
  for (const value of values) {
    bytes += size(value);
    if (bytes > maximum) return maximum + 1;
  }
  return bytes;
};

const cellBytes = (cell: XlsxCellEvidence, size: (value: string) => number): number => {
  const members: Array<EncodedMember> = [
    ["address", size(cell.address)],
    ["cellType", size(cell.cellType)],
    ["value", size(cell.value)],
  ];
  if (Option.isSome(cell.formattedText)) {
    members.push(["formattedText", size(cell.formattedText.value)]);
  }
  if (Option.isSome(cell.numberFormat)) {
    members.push(["numberFormat", size(cell.numberFormat.value)]);
  }
  if (Option.isSome(cell.formula)) members.push(["formula", size(cell.formula.value)]);
  return objectBytes(members);
};

const evidenceBytes = (
  evidence: StatementRowEvidence,
  size: (value: string) => number,
  maximum = maximumRowBytes
): number =>
  evidence.sourceFormat === "csv"
    ? objectBytes([
        ["sourceFormat", size(evidence.sourceFormat)],
        ["recordNumber", String(evidence.recordNumber).length],
        ["startLine", String(evidence.startLine).length],
        ["endLine", String(evidence.endLine).length],
        ["rawRecord", size(evidence.rawRecord)],
        ["fields", arrayBytes(evidence.fields, size, maximum)],
      ])
    : objectBytes([
        ["sourceFormat", size(evidence.sourceFormat)],
        ["sheetName", size(evidence.sheetName)],
        ["sheetIndex", String(evidence.sheetIndex).length],
        ["rowNumber", String(evidence.rowNumber).length],
        ["hidden", evidence.hidden ? 4 : "false".length],
        ["cells", arrayBytes(evidence.cells, (cell) => cellBytes(cell, size), maximum)],
      ]);

/** Measures heading JSON before allocation; overflow is above the heading admission ceiling. */
export const materializedHeaderBytes = (headers: ReadonlyArray<string>): number =>
  arrayBytes(
    headers,
    (value) => stringBytes(value, true, maximumMaterializedHeaderBytes),
    maximumMaterializedHeaderBytes
  );

/** Measures bounded derived JSON before encoding, including repeated evidence and escape expansion. Oversized input returns above the admission ceiling. */
export const materializedStatementBytes = (rows: ReadonlyArray<ParsedStatementRow>): number => {
  const sizes = new Map<string, number>();
  const size = (value: string): number => {
    const previous = sizes.get(value);
    if (previous !== undefined) {
      return previous;
    }
    const bytes = stringBytes(value, true, maximumMaterializedStatementBytes);
    sizes.set(value, bytes);
    return bytes;
  };
  return arrayBytes(
    rows,
    (row) =>
      objectBytes([
        ["recordNumber", String(row.recordNumber).length],
        ["fields", arrayBytes(row.fields, size, maximumMaterializedStatementBytes)],
        ["evidence", evidenceBytes(row.evidence, size, maximumMaterializedStatementBytes)],
      ]),
    maximumMaterializedStatementBytes
  );
};

const textValue = (bytes: number): StoredValue => ({ bytes, serial: textSerialBase + 2 * bytes });
const integerValue = (value: number): StoredValue => {
  const zeroSerial = 8;
  const oneSerial = 9;
  if (value === 0) return { bytes: 0, serial: zeroSerial };
  if (value === 1) return { bytes: 0, serial: oneSerial };
  const widths = [1, 2, 3, 4, sixByteInteger, eightByteInteger];
  const bitsPerByte = 8;
  for (const [index, bytes] of widths.entries()) {
    const bound = 2 ** (bytes * bitsPerByte - 1);
    if (value >= -bound && value < bound) return { bytes, serial: index + 1 };
  }
  return { bytes: overBudget, serial: 0 };
};

const varintBytes = (value: number): number => {
  let bytes = 1;
  for (let rest = value; rest >= varintBase; rest = Math.floor(rest / varintBase)) bytes += 1;
  return bytes;
};

const recordBytes = (values: ReadonlyArray<StoredValue>): number => {
  const serialBytes = values.reduce((sum, value) => sum + varintBytes(value.serial), 0);
  let headerBytes = serialBytes + 1;
  while (headerBytes !== serialBytes + varintBytes(headerBytes)) {
    headerBytes = serialBytes + varintBytes(headerBytes);
  }
  return headerBytes + values.reduce((sum, value) => sum + value.bytes, 0);
};

/**
 * Decides whether a prospective pending review record fits D1's 2,000,000-byte complete-record
 * limit before evidence serialization. Supply validated row evidence and the exact stored context:
 * generated review IDs must be UUIDs, known_money must remain NULL, and timestamps must be integer
 * epoch milliseconds. A false result requires terminal resource-limit settlement before encoding
 * or writing this row. Admission covers this record only, not the containing submission.
 */
export const statementReviewAdmission = (
  context: ReviewContext
): ((row: NeedsReviewStatementRow) => boolean) => {
  // Reuse only byte counts within this check; every repeated reference is still charged.
  // No encoded evidence or cross-User state survives the caller-owned invocation.
  const sizes = new Map<string, number>();
  const size = (value: string): number => {
    const existing = sizes.get(value);
    if (existing !== undefined) return existing;
    const bytes = stringBytes(value, true);
    sizes.set(value, bytes);
    return bytes;
  };
  const text = (value: string): StoredValue => textValue(stringBytes(value, false));
  const afterIssues = [
    text("pending"),
    integerValue(context.expiresAt),
    integerValue(context.createdAt),
    text(context.serviceMarket),
    text(context.locale),
    text(context.timeZone),
    text(context.sourceFormat),
    text(context.parserRevision),
    text(context.extractorRevision),
  ];
  return (row) => {
    const evidence = evidenceBytes(row.evidence, size);
    if (evidence > maximumRowBytes) return false;
    const issues = arrayBytes(row.issues, (issue) =>
      objectBytes([
        ["path", size(issue.path)],
        ["message", size(issue.message)],
      ])
    );
    return (
      recordBytes([
        textValue(uuidBytes),
        text(context.userId),
        text(context.submissionId),
        integerValue(row.recordNumber),
        text(row.reason),
        textValue(evidence),
        // The INSERT intentionally persists known_money as NULL today.
        { bytes: 0, serial: 0 },
        textValue(issues),
        ...afterIssues,
      ]) <= maximumRowBytes
    );
  };
};
