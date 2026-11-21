import { assert, expect, it } from "@effect/vitest";
import { Effect, Option, Predicate, Schema } from "effect";
import { StatementRowEvidence } from "~/core/ingestion/contract";
import { parseStatementFile } from "~/shell/ingestion/operations";

const bytes = (name: string): Effect.Effect<Uint8Array> =>
  Effect.tryPromise(() =>
    Bun.file(
      new URL(`../../../src/shell/ingestion/internal/fixtures/${name}.xlsx`, import.meta.url)
    ).bytes()
  ).pipe(Effect.orDie);

const evidenceCodec = Schema.fromJsonString(StatementRowEvidence);

it.effect("preserves a small shared-string workbook without expanding the source fixture", () =>
  Effect.gen(function* () {
    const source = yield* bytes("shared-string-small");
    const parsed = yield* parseStatementFile(source);
    expect(source.byteLength).toBeLessThan(3_000);
    expect(parsed.headers).toHaveLength(64);
    expect(parsed.rows).toHaveLength(1);
    const row = parsed.rows[0];

    if (row?.evidence.sourceFormat !== "xlsx") {
      return yield* Effect.die("Expected one XLSX row");
    }

    expect(row.fields).toHaveLength(64);
    expect(row.fields.every((field) => field === "x".repeat(4_096))).toBe(true);
    expect(row.evidence.cells[0]).toMatchObject({ address: "A2", cellType: "string" });
    expect(row.evidence.cells[63]).toMatchObject({ address: "BL2", cellType: "string" });
    expect(
      row.evidence.cells.every((cell) => Option.contains(cell.formattedText, cell.value))
    ).toBe(true);
    const evidence = yield* Schema.encodeEffect(evidenceCodec)(row.evidence);
    const evidenceBytes = new TextEncoder().encode(evidence).byteLength;
    expect(evidenceBytes).toBe(530_315);
  })
);

it.effect("measures the serialized row evidence from a highly compressed shared string", () =>
  Effect.gen(function* () {
    const source = yield* bytes("shared-string-row-limit");
    const parsed = yield* parseStatementFile(source);
    expect(source.byteLength).toBeLessThan(3_000);
    expect(parsed.rows).toHaveLength(1);
    const row = parsed.rows[0];

    if (row?.evidence.sourceFormat !== "xlsx") {
      return yield* Effect.die("Expected one XLSX row");
    }

    const evidence = yield* Schema.encodeEffect(evidenceCodec)(row.evidence);
    const evidenceBytes = new TextEncoder().encode(evidence).byteLength;
    expect(evidenceBytes).toBe(2_103_179);
  })
);

it.effect("rejects aggregate shared-string amplification before retaining parsed rows", () =>
  Effect.gen(function* () {
    const source = yield* bytes("shared-string-total-limit");
    expect(source.byteLength).toBeLessThan(8_000);
    const result = yield* Effect.result(parseStatementFile(source));
    assert(Predicate.isTagged(result, "Failure"));
    expect(result.failure.safeReason).toBe("resource-limit");
  })
);
