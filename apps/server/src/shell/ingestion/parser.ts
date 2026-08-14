import { inflateRawSync } from "node:zlib";
import { Data, Effect, Option, Schema } from "effect";
import { parse } from "csv-parse/sync";
import type { CellObject, Range, WorkBook, WorkSheet } from "xlsx";
import * as XLSX from "xlsx/xlsx.mjs";
import type {
  ParsedStatementRow,
  StatementMappingSample,
  XlsxCellEvidence,
} from "~/core/ingestion/model";
import type { StatementSourceFormat } from "~/core/ingestion/reference";
import { statementSourceFormat } from "./source-format";

const bytesPerKibibyte = 1024;
const maximumDecodedMebibytes = 5;
const maximumExpandedMebibytes = 25;
const maximumCsvRecordKibibytes = 256;
const maximumDecodedBytes = maximumDecodedMebibytes * bytesPerKibibyte * bytesPerKibibyte;
const maximumExpandedBytes = maximumExpandedMebibytes * bytesPerKibibyte * bytesPerKibibyte;
const maximumZipEntries = 1_000;
const maximumRows = 20_000;
const maximumColumns = 200;
const maximumCells = 250_000;
const maximumCsvRecordBytes = maximumCsvRecordKibibytes * bytesPerKibibyte;
const maximumSheets = 20;
const mappingSampleSize = 5;
const zipCentralDirectoryHeaderLength = 46;
const zipCentralDirectorySignature = 0x02014b50;
const zipStoredMethod = 0;
const zipDeflatedMethod = 8;
const zipCompressionMethodOffset = 10;
const zipCompressedSizeOffset = 20;
const zipExpandedSizeOffset = 24;
const zipNameLengthOffset = 28;
const zipExtraLengthOffset = 30;
const zipCommentLengthOffset = 32;
const zipLocalHeaderOffset = 42;
const zipLocalHeaderLength = 30;
const zipLocalNameLengthOffset = 26;
const zipLocalExtraLengthOffset = 28;
const zipHeaderRemainder = 45;
const isoDateLength = 10;
const carriageReturnCodePoint = 13;
const lineFeedCodePoint = 10;

/** Safe terminal parser failure that never exposes uploaded statement contents. */
export class StatementParseFailed extends Data.TaggedError("StatementParseFailed")<{
  readonly safeReason: "unsupported-format" | "resource-limit" | "malformed-file";
}> {}

/** Bounded parser output containing mapping context and conserved source rows. */
export type ParsedStatement = StatementMappingSample &
  Readonly<{
    rows: ReadonlyArray<ParsedStatementRow>;
  }>;

const CsvRecord = Schema.Struct({
  record: Schema.Array(Schema.String),
  raw: Schema.String,
  info: Schema.Struct({ lines: Schema.Int }),
});
type CsvRecord = typeof CsvRecord.Type;

const delimiterFor = (text: string): string => {
  const lineBreak = text.search(/\r?\n|\r/u);
  const firstLine = text.slice(0, lineBreak < 0 ? text.length : lineBreak);
  const candidates = [";", ",", "\t"];
  return candidates.reduce((best, candidate) =>
    firstLine.split(candidate).length > firstLine.split(best).length ? candidate : best
  );
};

const enforceCsvPhysicalLineLimit = (text: string): void => {
  let lineBreaks = 0;
  for (let index = 0; index < text.length; index += 1) {
    const codePoint = text.charCodeAt(index);
    const isUnpairedCarriageReturn =
      codePoint === carriageReturnCodePoint && text.charCodeAt(index + 1) !== lineFeedCodePoint;
    if (codePoint === lineFeedCodePoint || isUnpairedCarriageReturn) lineBreaks += 1;
    if (lineBreaks > maximumRows + 1) {
      throw new StatementParseFailed({ safeReason: "resource-limit" });
    }
  }
};

const parseCsv = (bytes: Uint8Array): ParsedStatement => {
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  enforceCsvPhysicalLineLimit(text);
  const records: ReadonlyArray<CsvRecord> = Schema.decodeUnknownSync(Schema.Array(CsvRecord))(
    parse(text, {
      bom: true,
      delimiter: delimiterFor(text),
      info: true,
      raw: true,
      relax_column_count: true,
      skip_empty_lines: true,
      max_record_size: maximumCsvRecordBytes,
    })
  );
  const [header, ...data] = records;
  if (header === undefined || header.record.length === 0 || header.record.length > maximumColumns) {
    throw new StatementParseFailed({ safeReason: "malformed-file" });
  }
  let cells = header.record.length;
  for (const record of data) {
    cells += record.record.length;
    if (record.record.length > maximumColumns || cells > maximumCells) {
      throw new StatementParseFailed({ safeReason: "resource-limit" });
    }
  }
  const rows = data.map((record, index): ParsedStatementRow => {
    const terminators = record.raw.match(/\r\n|\n|\r/gu)?.length ?? 0;
    const finalLine = /(?:\r\n|\n|\r)$/u.test(record.raw) ? 0 : 1;
    const physicalLines = Math.max(1, terminators + finalLine);
    const startLine = record.info.lines - physicalLines + 1;
    const fields = record.record.map(String);
    const recordNumber = index + 1;
    return {
      recordNumber,
      fields,
      evidence: {
        sourceFormat: "csv",
        recordNumber,
        startLine,
        endLine: record.info.lines,
        rawRecord: record.raw,
        fields,
      },
    };
  });
  return {
    sourceFormat: "csv",
    headers: [String(header.record[0]), ...header.record.slice(1).map(String)],
    sampleRows: rows.slice(0, mappingSampleSize).map((row) => row.fields),
    rows,
  };
};

const expandedZipEntrySize = (input: {
  readonly bytes: Uint8Array;
  readonly view: DataView;
  readonly offset: number;
  readonly remaining: number;
}): number => {
  const { bytes, offset, remaining, view } = input;
  const compressionMethod = view.getUint16(offset + zipCompressionMethodOffset, true);
  const compressedSize = view.getUint32(offset + zipCompressedSizeOffset, true);
  const declaredExpandedSize = view.getUint32(offset + zipExpandedSizeOffset, true);
  const localOffset = view.getUint32(offset + zipLocalHeaderOffset, true);
  if (localOffset + zipLocalHeaderLength > bytes.length) {
    throw new StatementParseFailed({ safeReason: "malformed-file" });
  }
  const localNameLength = view.getUint16(localOffset + zipLocalNameLengthOffset, true);
  const localExtraLength = view.getUint16(localOffset + zipLocalExtraLengthOffset, true);
  const dataOffset = localOffset + zipLocalHeaderLength + localNameLength + localExtraLength;
  const compressed = bytes.subarray(dataOffset, dataOffset + compressedSize);
  if (compressed.length !== compressedSize) {
    throw new StatementParseFailed({ safeReason: "malformed-file" });
  }
  let actualExpandedSize: number;
  if (compressionMethod === zipStoredMethod) actualExpandedSize = compressed.length;
  else if (compressionMethod === zipDeflatedMethod) {
    actualExpandedSize = inflateRawSync(compressed, { maxOutputLength: remaining }).length;
  } else throw new StatementParseFailed({ safeReason: "malformed-file" });
  if (actualExpandedSize !== declaredExpandedSize) {
    throw new StatementParseFailed({ safeReason: "malformed-file" });
  }
  return actualExpandedSize;
};

const assertZipExpansion = (bytes: Uint8Array): void => {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let expandedBytes = 0;
  let entries = 0;
  for (let offset = 0; offset + zipCentralDirectoryHeaderLength <= bytes.length; offset += 1) {
    if (view.getUint32(offset, true) !== zipCentralDirectorySignature) continue;
    entries += 1;
    expandedBytes += expandedZipEntrySize({
      bytes,
      view,
      offset,
      remaining: maximumExpandedBytes - expandedBytes,
    });
    const nameLength = view.getUint16(offset + zipNameLengthOffset, true);
    const extraLength = view.getUint16(offset + zipExtraLengthOffset, true);
    const commentLength = view.getUint16(offset + zipCommentLengthOffset, true);
    offset += zipHeaderRemainder + nameLength + extraLength + commentLength;
    if (entries > maximumZipEntries || expandedBytes > maximumExpandedBytes) {
      throw new StatementParseFailed({ safeReason: "resource-limit" });
    }
  }
  if (entries === 0) {
    throw new StatementParseFailed({ safeReason: "malformed-file" });
  }
};

const cellText = (cell: Option.Option<CellObject>): string =>
  Option.match(cell, {
    onNone: () => "",
    onSome: (value) => {
      if (value.v === undefined) return "";
      return value.v instanceof Date
        ? value.v.toISOString().slice(0, isoDateLength)
        : String(value.v);
    },
  });

const evidenceCellType = (cell: CellObject): XlsxCellEvidence["cellType"] => {
  if (cell.v === undefined) return "blank";
  if (cell.t === "b") return "boolean";
  if (cell.t === "e") return "error";
  if (cell.t === "d" || cell.v instanceof Date) return "date";
  return cell.t === "n" ? "number" : "string";
};

const evidenceCell = (address: string, cell: Option.Option<CellObject>): XlsxCellEvidence =>
  Option.match(cell, {
    onNone: () => ({
      address,
      cellType: "blank",
      value: "",
      formattedText: Option.none(),
      numberFormat: Option.none(),
      formula: Option.none(),
    }),
    onSome: (value) => ({
      address,
      cellType: evidenceCellType(value),
      value: value.v === undefined ? "" : String(value.v),
      formattedText: Option.fromUndefinedOr(value.w),
      numberFormat: Option.fromUndefinedOr(value.z === undefined ? undefined : String(value.z)),
      formula: Option.fromUndefinedOr(value.f),
    }),
  });

type SelectedSheet = Readonly<{
  sheetIndex: number;
  sheetName: string;
  sheet: WorkSheet;
  range: Range;
  originalRange: Range;
}>;

const selectedSheets = (workbook: WorkBook): ReadonlyArray<SelectedSheet> => {
  if (workbook.SheetNames.length > maximumSheets) {
    throw new StatementParseFailed({ safeReason: "resource-limit" });
  }
  const sheets = workbook.SheetNames.flatMap((sheetName, sheetIndex) => {
    const sheet = workbook.Sheets[sheetName];
    if (sheet?.["!ref"] === undefined) return [];
    const range = XLSX.utils.decode_range(sheet["!ref"]);
    const fullReference: unknown = sheet["!fullref"];
    const originalRange = XLSX.utils.decode_range(
      typeof fullReference === "string" ? fullReference : sheet["!ref"]
    );
    assertSheetLimits(originalRange);
    return [{ sheetIndex, sheetName, sheet, range, originalRange }];
  });
  if (sheets.length === 0) throw new StatementParseFailed({ safeReason: "malformed-file" });
  return sheets;
};

const assertSheetLimits = (range: Range): number => {
  const columnCount = range.e.c - range.s.c + 1;
  const rowCount = range.e.r - range.s.r;
  const exceedsDimensions = columnCount > maximumColumns || rowCount > maximumRows;
  if (exceedsDimensions || columnCount * (rowCount + 1) > maximumCells) {
    throw new StatementParseFailed({ safeReason: "resource-limit" });
  }
  return columnCount;
};

const xlsxRows = (
  selected: SelectedSheet,
  columnCount: number,
  recordOffset: number
): ReadonlyArray<ParsedStatementRow> => {
  const rows: Array<ParsedStatementRow> = [];
  for (let rowIndex = selected.range.s.r + 1; rowIndex <= selected.range.e.r; rowIndex += 1) {
    const cells = Array.from({ length: columnCount }, (_, offset) => {
      const address = XLSX.utils.encode_cell({
        r: rowIndex,
        c: selected.range.s.c + offset,
      });
      return { address, cell: Option.fromUndefinedOr(selected.sheet[address]) };
    });
    const fields = cells.map(({ cell }) => cellText(cell));
    if (fields.every((field) => field.length === 0)) continue;
    rows.push({
      recordNumber: recordOffset + rows.length + 1,
      fields,
      evidence: {
        sourceFormat: "xlsx",
        sheetName: selected.sheetName,
        sheetIndex: selected.sheetIndex,
        rowNumber: rowIndex + 1,
        hidden: selected.sheet["!rows"]?.[rowIndex]?.hidden === true,
        cells: cells.map(({ address, cell }) => evidenceCell(address, cell)),
      },
    });
  }
  return rows;
};

const sheetHeaders = (selected: SelectedSheet, columnCount: number): ReadonlyArray<string> =>
  Array.from({ length: columnCount }, (_, offset) =>
    cellText(
      Option.fromUndefinedOr(
        selected.sheet[
          XLSX.utils.encode_cell({ r: selected.range.s.r, c: selected.range.s.c + offset })
        ]
      )
    )
  );

const sameHeaders = (left: ReadonlyArray<string>, right: ReadonlyArray<string>): boolean =>
  left.length === right.length && left.every((header, index) => header === right[index]);

const parseXlsx = (bytes: Uint8Array): ParsedStatement => {
  assertZipExpansion(bytes);
  const workbook = XLSX.read(bytes, {
    type: "array",
    raw: true,
    cellFormula: true,
    cellNF: true,
    cellText: true,
    cellDates: true,
    cellStyles: true,
    sheetRows: maximumRows + 2,
  });
  const sheets = selectedSheets(workbook);
  let totalCells = 0;
  let expectedHeaders = Option.none<ReadonlyArray<string>>();
  const rows: Array<ParsedStatementRow> = [];
  for (const selected of sheets) {
    const columnCount = assertSheetLimits(selected.range);
    totalCells += columnCount * (selected.originalRange.e.r - selected.originalRange.s.r + 1);
    if (totalCells > maximumCells) throw new StatementParseFailed({ safeReason: "resource-limit" });
    const headers = sheetHeaders(selected, columnCount);
    if (headers.every((header) => header.length === 0)) {
      throw new StatementParseFailed({ safeReason: "malformed-file" });
    }
    if (Option.isSome(expectedHeaders) && !sameHeaders(expectedHeaders.value, headers)) {
      throw new StatementParseFailed({ safeReason: "malformed-file" });
    }
    expectedHeaders = Option.some(headers);
    rows.push(...xlsxRows(selected, columnCount, rows.length));
    if (rows.length > maximumRows) {
      throw new StatementParseFailed({ safeReason: "resource-limit" });
    }
  }
  const headers = Option.getOrThrow(expectedHeaders);
  return {
    sourceFormat: "xlsx",
    headers: [String(headers[0]), ...headers.slice(1)],
    sampleRows: rows.slice(0, mappingSampleSize).map((row) => row.fields),
    rows,
  };
};

const detectedFormat = (bytes: Uint8Array): StatementSourceFormat => statementSourceFormat(bytes);

/** Decodes one bounded untrusted statement without executing workbook active content. */
export const parseStatementFile = (
  bytes: Uint8Array
): Effect.Effect<ParsedStatement, StatementParseFailed> =>
  Effect.try({
    try: () => {
      if (bytes.length === 0) throw new StatementParseFailed({ safeReason: "malformed-file" });
      if (bytes.length > maximumDecodedBytes) {
        throw new StatementParseFailed({ safeReason: "resource-limit" });
      }
      return detectedFormat(bytes) === "xlsx" ? parseXlsx(bytes) : parseCsv(bytes);
    },
    catch: (failure) =>
      failure instanceof StatementParseFailed
        ? failure
        : new StatementParseFailed({ safeReason: "malformed-file" }),
  });
