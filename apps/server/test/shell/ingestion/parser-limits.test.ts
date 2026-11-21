import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { expect, it } from "@effect/vitest";
import { Effect, Exit, Predicate, Schema } from "effect";
import { StatementParseFailed } from "~/shell/ingestion/contract";
import { parseStatementFile } from "~/shell/ingestion/operations";

const encode = (text: string): Uint8Array => new TextEncoder().encode(text);

const BufferDecoder = Schema.Struct({ toString: Schema.declare(Predicate.isFunction) });

const resourceLimit = Exit.fail(new StatementParseFailed({ safeReason: "resource-limit" }));

const maximumColumns = 200;

const maximumCells = 250_000;

const maximumRows = 20_000;

const maximumBytes = 5 * 1024 * 1024;

const fullRow = Array.from({ length: maximumColumns }, () => "").join(",");

it.effect("rejects delimiter-only maximum-byte uploads as resource limits", () =>
  Effect.forEach(
    [",", ";", "\t"],
    (delimiter) =>
      Effect.gen(function* () {
        const result = yield* Effect.exit(
          parseStatementFile(encode(delimiter.repeat(maximumBytes)))
        );

        assert.deepStrictEqual(result, resourceLimit);
      }),
    { discard: true }
  )
);

it.effect("stops on the first surplus header or data field before a malformed tail", () =>
  Effect.forEach(
    ["", "Header,Other\n"],
    (prefix) =>
      Effect.gen(function* () {
        const result = yield* Effect.exit(
          parseStatementFile(encode(`${prefix}${",".repeat(maximumColumns + 1)}"unterminated`))
        );

        assert.deepStrictEqual(result, resourceLimit);
      }),
    { discard: true }
  )
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
  Effect.forEach(
    ["\n", "\r", "\r\n"],
    (newline) =>
      Effect.gen(function* () {
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
          rawRecord: newline === "\r\n" ? rawRecord.slice(0, -1) : rawRecord,
          fields: ["00123", `a,b;\t"quoted"${newline}next`, ""],
        });
      }),
    { discard: true }
  )
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

it.effect("bounds decoding work for long leading fields followed by many empty cells", () =>
  Effect.gen(function* () {
    const leadingField = "x".repeat(250_000);
    const rawRecord = `${leadingField}${fullRow}\n`;
    const bytes = encode(`${fullRow}\n${rawRecord.repeat(20)}`);
    const prototype: unknown = Object.getOwnPropertyDescriptor(Buffer, "prototype")?.value;

    if (!Schema.is(BufferDecoder)(prototype)) return yield* Effect.die("Missing Buffer decoder");
    const decodeBuffer = prototype.toString;
    let decodedCharacters = 0;

    const observeDecoding = function (this: unknown, ...args: Array<unknown>): string {
      const result: unknown = decodeBuffer.apply(this, args);
      const decoded = Schema.decodeUnknownSync(Schema.String)(result);
      decodedCharacters += decoded.length;

      return decoded;
    };

    assert.ok(Reflect.set(prototype, "toString", observeDecoding));

    const parsed = yield* parseStatementFile(bytes).pipe(
      Effect.ensuring(Effect.sync(() => Reflect.set(prototype, "toString", decodeBuffer)))
    );

    expect(parsed.rows).toHaveLength(20);
    expect(parsed.rows.every((row) => row.fields.length === maximumColumns)).toBe(true);
    expect(parsed.rows[0]?.fields).toEqual([
      leadingField,
      ...Array.from({ length: 199 }, () => ""),
    ]);
    expect(parsed.rows[0]?.evidence).toMatchObject({
      rawRecord,
      startLine: 2,
      endLine: 2,
    });
    expect(decodedCharacters).toBeLessThan(bytes.length * 6);
  })
);
