import { Option, Schema } from "effect";
import { admitXlsxArchive } from "./xlsx-admission";
import { type Options, parse } from "csv-parse/sync";
import type { CellObject, Range, WorkBook, WorkSheet } from "xlsx";
import * as XLSX from "xlsx/xlsx.mjs";
import type { ParsedStatementRow, XlsxCellEvidence } from "~/core/ingestion/contract";
import type { StatementMappingSample } from "./material";
import {
  type ParsedStatement,
  StatementParseFailed,
  statementParserLimits,
} from "~/shell/ingestion/contract";

const bytesPerKibibyte = 1024;
const maximumCsvRecordKibibytes = 256;
const maximumRows = statementParserLimits.maximumRows;
const maximumColumns = 200;
const maximumCells = 250_000;
const maximumXlsxCells = statementParserLimits.maximumXlsxCells;
const maximumCsvRecordBytes = maximumCsvRecordKibibytes * bytesPerKibibyte;
const maximumSheets = 20;
const mappingSampleSize = 5;
const isoDateLength = 10;
const carriageReturnCodePoint = 13;
const lineFeedCodePoint = 10;

type ParsedStatementMaterial = ParsedStatement & StatementMappingSample;

const CsvRecord = Schema.Struct({
  record: Schema.Array(Schema.String),
  raw: Schema.String,
  info: Schema.Struct({ lines: Schema.Int }),
});
type CsvRecord = typeof CsvRecord.Type;

const delimiterFor = (text: string): string => {
  const candidates = [
    { delimiter: ";", count: 0 },
    { delimiter: ",", count: 0 },
    { delimiter: "\t", count: 0 },
  ];
  // Keep the existing first-physical-line scoring and tie order without allocating fields.
  for (const character of text) {
    if (character === "\r" || character === "\n") break;
    for (const candidate of candidates) {
      if (character === candidate.delimiter) candidate.count += 1;
    }
  }
  return candidates.reduce((best, candidate) => (candidate.count > best.count ? candidate : best))
    .delimiter;
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

const enforceCsvDimensions = (text: string, options: Options): void => {
  let cells = 0;
  parse(text, {
    ...options,
    // Field context includes a copy of the entire raw prefix when raw is enabled.
    // Keep dimension admission raw-free and discard each bounded record immediately.
    info: false,
    raw: false,
    cast: (value, context): string => {
      cells += 1;
      if (
        context.index >= maximumColumns ||
        context.records > maximumRows ||
        cells > maximumCells
      ) {
        throw new StatementParseFailed({ safeReason: "resource-limit" });
      }
      return value;
    },
    on_record: (): ReturnType<NonNullable<Options["on_record"]>> => undefined,
  });
};

export const parseCsv = (bytes: Uint8Array): ParsedStatementMaterial => {
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  enforceCsvPhysicalLineLimit(text);
  const options = {
    bom: true,
    delimiter: delimiterFor(text),
    relax_column_count: true,
    skip_empty_lines: true,
    max_record_size: maximumCsvRecordBytes,
  };
  enforceCsvDimensions(text, options);
  // Both passes share the parser's grammar. Evidence is decoded only after admission,
  // without a field callback that would repeatedly copy a long leading field.
  const records: ReadonlyArray<CsvRecord> = Schema.decodeUnknownSync(Schema.Array(CsvRecord))(
    parse(text, { ...options, info: true, raw: true })
  );
  const [header, ...data] = records;
  if (header === undefined || header.record.length === 0) {
    throw new StatementParseFailed({ safeReason: "malformed-file" });
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
  if (exceedsDimensions || columnCount * (rowCount + 1) > maximumXlsxCells) {
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

export const parseXlsx = (bytes: Uint8Array): ParsedStatementMaterial => {
  const admitted = admitXlsxArchive(bytes);
  const options = {
    type: "array",
    raw: true,
    cellFormula: true,
    cellNF: true,
    cellText: true,
    cellDates: true,
    cellStyles: true,
    cellHTML: false,
    sheetRows: maximumRows + 2,
  } as const;
  const workbook = XLSX.read(admitted, options);
  const sheets = selectedSheets(workbook);
  let totalCells = 0;
  let expectedHeaders = Option.none<ReadonlyArray<string>>();
  const rows: Array<ParsedStatementRow> = [];
  for (const selected of sheets) {
    const columnCount = assertSheetLimits(selected.range);
    totalCells += columnCount * (selected.originalRange.e.r - selected.originalRange.s.r + 1);
    if (totalCells > maximumXlsxCells) {
      throw new StatementParseFailed({ safeReason: "resource-limit" });
    }
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
