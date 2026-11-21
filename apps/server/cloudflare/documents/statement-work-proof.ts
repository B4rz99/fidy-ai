import { Effect, Option, Schema } from "effect";
import { StatementRowEvidence } from "../../src/core/ingestion/contract";
import { interpretStatementRows, mechanicalMappingFor } from "../../src/core/ingestion/operations";
import { TransactionExtraction } from "../../src/core/transactions/contract";
import type { ParsedStatement } from "../../src/shell/ingestion/contract";

const chunkSize = 32;

const encoder = new TextEncoder();

const evidenceCodec = Schema.fromJsonString(StatementRowEvidence);

const extractionDecoder = Schema.decodeUnknownEffect(Schema.toCodecJson(TransactionExtraction));

const byteSize = (value: string): number => encoder.encode(value).length;

export const measureStatementWork = Effect.fn(function* (parsed: ParsedStatement) {
  let logicalTextBytes = 0;

  const encodedEvidence = yield* Effect.forEach(parsed.rows, (row) =>
    Schema.encodeEffect(evidenceCodec)(row.evidence)
  );

  for (const row of parsed.rows) {
    logicalTextBytes += row.fields.reduce((sum, field) => sum + byteSize(field), 0);

    if (row.evidence.sourceFormat === "xlsx") {
      for (const cell of row.evidence.cells) {
        logicalTextBytes += byteSize(cell.value);
        logicalTextBytes += Option.match(cell.formattedText, { onNone: () => 0, onSome: byteSize });
      }
    }
  }

  const serializedEvidenceBytes = encodedEvidence.reduce(
    (sum, encoded) => sum + byteSize(encoded),
    0
  );

  const mapping = mechanicalMappingFor(parsed.headers);
  let interpretedRows = 0;
  let acceptedRows = 0;
  let reviewRows = 0;
  const startedAt = performance.now();

  if (Option.isSome(mapping)) {
    const starts = Array.from(
      { length: Math.ceil(parsed.rows.length / chunkSize) },
      (_, index) => index * chunkSize
    );

    const chunks = yield* Effect.forEach(starts, (start) =>
      interpretStatementRows(
        {
          rows: parsed.rows.slice(start, start + chunkSize),
          mapping: mapping.value,
          timeZone: "America/Bogota",
        },
        extractionDecoder
      )
    );

    const outcomes = chunks.flatMap((results) => results.outcomes);
    interpretedRows = outcomes.length;
    acceptedRows = outcomes.filter((row) => row.outcome === "accepted").length;
    reviewRows = outcomes.filter((row) => row.outcome === "needs-review").length;
  }

  return {
    logicalTextBytes,
    serializedEvidenceBytes,
    interpretedRows,
    acceptedRows,
    reviewRows,
    interpretationMilliseconds: performance.now() - startedAt,
  };
});
