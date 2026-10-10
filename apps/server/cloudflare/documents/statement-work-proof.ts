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

/** Nonproduction characterization only: execute the native interpreter seam in its 32-row chunks. */
export const measureStatementWork = Effect.fn(function* (parsed: ParsedStatement) {
  let logicalTextBytes = 0;
  let serializedEvidenceBytes = 0;
  for (const row of parsed.rows) {
    logicalTextBytes += row.fields.reduce((sum, field) => sum + byteSize(field), 0);
    if (row.evidence.sourceFormat === "xlsx") {
      for (const cell of row.evidence.cells) {
        logicalTextBytes += byteSize(cell.value);
        logicalTextBytes += Option.match(cell.formattedText, { onNone: () => 0, onSome: byteSize });
      }
    }
    serializedEvidenceBytes += byteSize(yield* Schema.encodeEffect(evidenceCodec)(row.evidence));
  }
  const mapping = mechanicalMappingFor(parsed.headers);
  let interpretedRows = 0;
  let acceptedRows = 0;
  let reviewRows = 0;
  const startedAt = performance.now();
  if (Option.isSome(mapping)) {
    for (let start = 0; start < parsed.rows.length; start += chunkSize) {
      const results = yield* interpretStatementRows(
        {
          rows: parsed.rows.slice(start, start + chunkSize),
          mapping: mapping.value,
          timeZone: "America/Bogota",
        },
        extractionDecoder
      );
      interpretedRows += results.outcomes.length;
      acceptedRows += results.outcomes.filter((row) => row.outcome === "accepted").length;
      reviewRows += results.outcomes.filter((row) => row.outcome === "needs-review").length;
    }
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
