import { expect, it } from "@effect/vitest";
import { Effect, Option, Schema } from "effect";
import { StatementRowEvidence } from "~/core/ingestion/contract";
import { parseStatementFile } from "./operations";

const bytes = (name: string): Effect.Effect<Uint8Array> =>
  Effect.tryPromise(() =>
    Bun.file(new URL(`./internal/fixtures/${name}.xlsx`, import.meta.url)).bytes()
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

// Parsing does not know which evidence will be persisted. Native review-row admission
// rejects this amplification only when the row requires review; accepted captures stay valid.
it.effect("characterizes shared-string row evidence above the D1 string limit", () =>
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

it.effect("characterizes repeated shared-string material above the ZIP expansion budget", () =>
  Effect.gen(function* () {
    const source = yield* bytes("shared-string-total-limit");
    const parsed = yield* parseStatementFile(source);
    expect(source.byteLength).toBeLessThan(8_000);
    expect(parsed.rows).toHaveLength(40);
    // Count referenced text only. Do not serialize the entire amplified document in this probe.
    let textBytes = 0;
    for (const row of parsed.rows) {
      if (row.evidence.sourceFormat !== "xlsx") return yield* Effect.die("Expected XLSX evidence");
      for (const field of row.fields) textBytes += field.length;
      for (const cell of row.evidence.cells) {
        textBytes += cell.value.length;
        textBytes += Option.getOrElse(cell.formattedText, () => "").length;
      }
    }
    expect(textBytes).toBe(31_457_280);
  })
);
