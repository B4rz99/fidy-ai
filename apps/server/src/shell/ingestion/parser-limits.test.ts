import assert from "node:assert/strict";
import { expect, it } from "@effect/vitest";
import { Effect, Exit } from "effect";
import { StatementParseFailed } from "./contract";
import { parseStatementFile } from "./operations";

const encode = (text: string): Uint8Array => new TextEncoder().encode(text);
const resourceLimit = Exit.fail(new StatementParseFailed({ safeReason: "resource-limit" }));
const maximumColumns = 200;
const maximumCells = 250_000;
const maximumRows = 20_000;
const maximumBytes = 5 * 1024 * 1024;
const fullRow = Array.from({ length: maximumColumns }, () => "").join(",");

it.effect("rejects delimiter-only maximum-byte uploads as resource limits", () =>
  Effect.gen(function* () {
    for (const delimiter of [",", ";", "\t"]) {
      const result = yield* Effect.exit(parseStatementFile(encode(delimiter.repeat(maximumBytes))));
      assert.deepStrictEqual(result, resourceLimit);
    }
  })
);

it.effect("stops on the first surplus header or data field before a malformed tail", () =>
  Effect.gen(function* () {
    for (const prefix of ["", "Header,Other\n"]) {
      const result = yield* Effect.exit(
        parseStatementFile(encode(`${prefix}${",".repeat(maximumColumns + 1)}"unterminated`))
      );
      assert.deepStrictEqual(result, resourceLimit);
    }
  })
);

it.effect("counts empty header and data cells exactly and refuses the first surplus cell", () =>
  Effect.gen(function* () {
    const recordCount = maximumCells / maximumColumns;
    const exact = `${fullRow}\n`.repeat(recordCount);
    const accepted = yield* parseStatementFile(encode(exact));
    expect(accepted.headers).toHaveLength(maximumColumns);
    expect(accepted.rows).toHaveLength(recordCount - 1);
    expect(accepted.rows.at(-1)?.fields).toEqual(Array.from({ length: maximumColumns }, () => ""));
    const rejected = yield* Effect.exit(parseStatementFile(encode(`${exact},"unterminated`)));
    assert.deepStrictEqual(rejected, resourceLimit);
  })
);

it.effect("bounds the final logical record even when it has no trailing newline", () =>
  Effect.gen(function* () {
    const exact = `Header\n${"value\n".repeat(maximumRows - 1)}value`;
    const parsed = yield* parseStatementFile(encode(exact));
    expect(parsed.rows).toHaveLength(maximumRows);
    const rejected = yield* Effect.exit(parseStatementFile(encode(`${exact}\nvalue`)));
    assert.deepStrictEqual(rejected, resourceLimit);
  })
);

it.effect("preserves quoted delimiters, escaped quotes, raw records and physical lines", () =>
  Effect.gen(function* () {
    for (const newline of ["\n", "\r", "\r\n"]) {
      const rawRecord = `00123,"a,b;\t""quoted""${newline}next",""${newline}`;
      const parsed = yield* parseStatementFile(encode(`\ufeffA,B,C${newline}${rawRecord}`));
      expect(parsed.headers).toEqual(["A", "B", "C"]);
      expect(parsed.rows).toHaveLength(1);
      expect(parsed.rows[0]?.fields).toEqual(["00123", `a,b;\t"quoted"${newline}next`, ""]);
      expect(parsed.rows[0]?.evidence).toEqual({
        sourceFormat: "csv",
        recordNumber: 1,
        startLine: newline === "\r\n" ? 3 : 2,
        endLine: newline === "\r\n" ? 4 : 3,
        // Csv-parse retains only the first character of a CRLF record terminator.
        rawRecord: newline === "\r\n" ? rawRecord.slice(0, -1) : rawRecord,
        fields: ["00123", `a,b;\t"quoted"${newline}next`, ""],
      });
    }
  })
);

it.effect("keeps empty-line, ragged-record, delimiter tie and string-value semantics", () =>
  Effect.gen(function* () {
    const tied = yield* parseStatementFile(
      encode('A;B,C\n"";00123\n\n"a;b"\ntrue;2026-01-01;extra')
    );
    expect(tied.headers).toEqual(["A", "B,C"]);
    expect(tied.rows.map((row) => row.fields)).toEqual([
      ["", "00123"],
      ["a;b"],
      ["true", "2026-01-01", "extra"],
    ]);
    const mixedLines = yield* parseStatementFile(encode('A,B\n"",1\r2\n'));
    expect(mixedLines.rows[0]?.fields).toEqual(["", "1\r2"]);
    const malformed = yield* Effect.exit(parseStatementFile(encode('A,B\n"unterminated')));
    assert.deepStrictEqual(
      malformed,
      Exit.fail(new StatementParseFailed({ safeReason: "malformed-file" }))
    );
  })
);

it.effect("does not count quoted delimiters or escaped quotes as additional cells", () =>
  Effect.gen(function* () {
    const punctuation = ",;\t".repeat(maximumColumns + 1);
    const parsed = yield* parseStatementFile(encode(`A,B\n"${punctuation}""quoted""",00123`));
    expect(parsed.rows[0]?.fields).toEqual([`${punctuation}"quoted"`, "00123"]);
  })
);
