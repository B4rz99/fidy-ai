import { expect, it } from "@effect/vitest";
import { DateTime, Effect, Exit, Option, Schema } from "effect";
import * as XLSX from "xlsx/xlsx.mjs";
import { ParsedStatementRow } from "~/core/ingestion/model";
import { parseStatementFile } from "./parser";

const syntheticCellDate = DateTime.toDate(DateTime.makeUnsafe("2026-02-05T00:00:00Z"));
const zipCentralHeaderLength = 46;
const zipCentralSignature = 0x02014b50;
const zipCompressionMethodOffset = 10;
const zipCompressedSizeOffset = 20;
const zipExpandedSizeOffset = 24;
const zipLocalOffset = 42;
const unsupportedZipCompressionMethod = 99;
const missingOffset = -1;

const firstCentralDirectoryOffset = (bytes: Uint8Array): number => {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let offset = 0; offset + zipCentralHeaderLength <= bytes.length; offset += 1) {
    if (view.getUint32(offset, true) === zipCentralSignature) return offset;
  }
  return missingOffset;
};

it.effect("preserves CSV records and multiline physical line positions", () =>
  Effect.gen(function* () {
    const bytes = new TextEncoder().encode(
      'Date;Amount;Description;Type\n05/02/2026;25.000;"Mercado\ncentral";DEBIT\n06/02/2026;10.000;Taxi;DEBIT\n'
    );
    const parsed = yield* parseStatementFile(bytes);

    expect(parsed.sourceFormat).toBe("csv");
    expect(parsed.headers).toEqual(["Date", "Amount", "Description", "Type"]);
    expect(parsed.rows).toHaveLength(2);
    expect(parsed.rows[0]?.evidence).toMatchObject({
      sourceFormat: "csv",
      recordNumber: 1,
      startLine: 2,
      endLine: 3,
    });
    expect(parsed.rows[0]?.fields).toEqual(["05/02/2026", "25.000", "Mercado\ncentral", "DEBIT"]);
  })
);

it.effect("sniffs CSV delimiters and rejects malformed or hostile bounds", () =>
  Effect.gen(function* () {
    const comma = yield* parseStatementFile(new TextEncoder().encode("A,B\n1,2"));
    const tab = yield* parseStatementFile(new TextEncoder().encode("A\tB\n1\t2"));
    const carriageReturn = yield* parseStatementFile(new TextEncoder().encode("A,B\r1,2"));
    const carriageReturnLineFeed = yield* parseStatementFile(
      new TextEncoder().encode("A,B\r\n1,2")
    );
    expect(comma.headers).toEqual(["A", "B"]);
    expect(tab.headers).toEqual(["A", "B"]);
    expect(carriageReturn.rows).toHaveLength(1);
    expect(carriageReturnLineFeed.rows).toHaveLength(1);

    const malformedInputs = [
      new Uint8Array(),
      Uint8Array.from([0xff]),
      new TextEncoder().encode('A,B\n"unterminated,2'),
      new TextEncoder().encode(
        `${Array.from({ length: 201 }, (_, index) => `H${index}`).join(",")}\n`
      ),
    ];
    for (const input of malformedInputs) {
      const failed = yield* Effect.exit(parseStatementFile(input));
      expect(Exit.isFailure(failed)).toBe(true);
    }

    const manyRows = `A\n${"1\n".repeat(20_001)}`;
    const rowLimit = yield* Effect.exit(parseStatementFile(new TextEncoder().encode(manyRows)));
    expect(Exit.isFailure(rowLimit)).toBe(true);

    const headers = Array.from({ length: 200 }, (_, index) => `H${index}`).join(",");
    const row = Array.from({ length: 200 }, () => "1").join(",");
    const tooManyCells = `${headers}\n${`${row}\n`.repeat(1251)}`;
    const cellLimit = yield* Effect.exit(
      parseStatementFile(new TextEncoder().encode(tooManyCells))
    );
    expect(Exit.isFailure(cellLimit)).toBe(true);
  })
);

it.effect("preserves XLSX blank, date, boolean, and error cell types", () =>
  Effect.gen(function* () {
    const sheet = XLSX.utils.aoa_to_sheet([
      ["Date", "Boolean", "Error", "Blank"],
      [syntheticCellDate, true, undefined, undefined],
      [],
      ["text", 1, undefined, "present"],
    ]);
    sheet.C2 = { t: "e", v: 7 };
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, sheet, "Types");
    const buffer: unknown = XLSX.write(workbook, {
      type: "array",
      bookType: "xlsx",
      cellDates: true,
    });
    if (!(buffer instanceof ArrayBuffer)) return yield* Effect.die("Expected XLSX ArrayBuffer");

    const parsed = yield* parseStatementFile(new Uint8Array(buffer));
    expect(parsed.rows).toHaveLength(2);
    expect(Schema.is(ParsedStatementRow)(parsed.rows[0])).toBe(true);
    expect(parsed.rows[0]?.fields.slice(1)).toEqual(["true", "7", ""]);
    const evidence = parsed.rows[0]?.evidence;
    expect(evidence?.sourceFormat).toBe("xlsx");
    if (evidence?.sourceFormat !== "xlsx") return;
    expect(evidence.hidden).toBe(false);
    expect(evidence.cells.map((cell) => cell.cellType)).toEqual([
      "date",
      "boolean",
      "error",
      "blank",
    ]);
  })
);

it.effect("rejects forged ZIP expansion metadata before workbook parsing", () =>
  Effect.gen(function* () {
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([["A"], ["value"]]), "Data");
    const buffer: unknown = XLSX.write(workbook, { type: "array", bookType: "xlsx" });
    if (!(buffer instanceof ArrayBuffer)) return yield* Effect.die("Expected XLSX ArrayBuffer");
    const original = new Uint8Array(buffer);
    const centralOffset = firstCentralDirectoryOffset(original);
    expect(centralOffset).toBeGreaterThanOrEqual(0);
    const mutations: ReadonlyArray<(view: DataView) => void> = [
      (view: DataView): void => {
        view.setUint32(centralOffset + zipExpandedSizeOffset, 1, true);
      },
      (view: DataView): void => {
        view.setUint16(
          centralOffset + zipCompressionMethodOffset,
          unsupportedZipCompressionMethod,
          true
        );
      },
      (view: DataView): void => {
        view.setUint32(centralOffset + zipCompressedSizeOffset, original.length, true);
      },
      (view: DataView): void => {
        view.setUint32(centralOffset + zipLocalOffset, original.length, true);
      },
    ];
    for (const mutate of mutations) {
      const bytes = original.slice();
      mutate(new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength));
      const failed = yield* Effect.exit(parseStatementFile(bytes));
      expect(Exit.isFailure(failed)).toBe(true);
    }
  })
);

it.effect("accounts for rows across compatible XLSX worksheets", () =>
  Effect.gen(function* () {
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(
      workbook,
      XLSX.utils.aoa_to_sheet([
        ["Date", "Amount"],
        ["2026-01-01", 10],
      ]),
      "January"
    );
    XLSX.utils.book_append_sheet(
      workbook,
      XLSX.utils.aoa_to_sheet([
        ["Date", "Amount"],
        ["2026-02-01", 20],
      ]),
      "February"
    );
    const buffer: unknown = XLSX.write(workbook, { type: "array", bookType: "xlsx" });
    if (!(buffer instanceof ArrayBuffer)) return yield* Effect.die("Expected XLSX ArrayBuffer");

    const parsed = yield* parseStatementFile(new Uint8Array(buffer));
    expect(parsed.rows).toHaveLength(2);
    expect(parsed.rows.map((row) => row.recordNumber)).toEqual([1, 2]);
    expect(parsed.rows[1]?.evidence).toMatchObject({ sourceFormat: "xlsx", sheetName: "February" });
  })
);

it.effect("rejects XLSX dimensions truncated by the bounded SheetJS read", () =>
  Effect.gen(function* () {
    const workbook = XLSX.utils.book_new();
    const sheet = XLSX.utils.aoa_to_sheet([["Date", "Amount"]]);
    sheet["!ref"] = "A1:B20002";
    XLSX.utils.book_append_sheet(workbook, sheet, "Oversized");
    const buffer: unknown = XLSX.write(workbook, { type: "array", bookType: "xlsx" });
    if (!(buffer instanceof ArrayBuffer)) return yield* Effect.die("Expected XLSX ArrayBuffer");

    const result = yield* Effect.exit(parseStatementFile(new Uint8Array(buffer)));
    expect(Exit.isFailure(result)).toBe(true);
  })
);

it.effect("rejects worksheets with incompatible tabular formats", () =>
  Effect.gen(function* () {
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([["A"], ["one"]]), "One");
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([["B"], ["two"]]), "Two");
    const buffer: unknown = XLSX.write(workbook, { type: "array", bookType: "xlsx" });
    if (!(buffer instanceof ArrayBuffer)) return yield* Effect.die("Expected XLSX ArrayBuffer");
    expect(Exit.isFailure(yield* Effect.exit(parseStatementFile(new Uint8Array(buffer))))).toBe(
      true
    );
  })
);

it.effect("reads XLSX cells directly and retains hidden/formula evidence", () =>
  Effect.gen(function* () {
    const bytes = new Uint8Array(
      yield* Effect.promise(() =>
        Bun.file(new URL("./fixtures/synthetic-statement.xlsx", import.meta.url)).arrayBuffer()
      )
    );
    const parsed = yield* parseStatementFile(bytes);

    expect(parsed.sourceFormat).toBe("xlsx");
    expect(parsed.headers).toEqual(["Date", "Amount", "Description", "Type"]);
    expect(parsed.rows).toHaveLength(2);
    expect(parsed.rows[0]?.fields).toEqual(["2026-02-05", "25000", "Mercado", "DEBIT"]);
    const evidence = parsed.rows[1]?.evidence;
    expect(evidence?.sourceFormat).toBe("xlsx");
    if (evidence?.sourceFormat !== "xlsx") return;
    expect(evidence.hidden).toBe(true);
    expect(evidence.cells[1]?.formula).toEqual(Option.some("12500*2"));
    expect(evidence.cells[1]?.value).toBe("25000");
  })
);
