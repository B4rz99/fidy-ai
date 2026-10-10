import { expect, it } from "vitest";
import { Option, Schema } from "effect";
import {
  type NeedsReviewStatementRow,
  StatementRowEvidence,
} from "../../src/core/ingestion/contract";
import { statementReviewAdmission } from "./internal/statement-review-budget";

const context = {
  userId: "10000000-0000-4000-8000-000000000101",
  submissionId: "10000000-0000-4000-8000-000000000601",
  serviceMarket: "CO",
  locale: "es-CO",
  timeZone: "America/Bogota",
  sourceFormat: "csv" as const,
  parserRevision: "statement-parser-v1",
  extractorRevision: "statement-mechanical-v1",
  expiresAt: 1_800_086_400_000,
  createdAt: 1_800_000_000_000,
};
const encodedLength = (value: unknown): number =>
  new TextEncoder().encode(JSON.stringify(value)).byteLength;
const evidenceCodec = Schema.toCodecJson(StatementRowEvidence);

const reviewRow = (raw: string, extraIssueBytes: number): NeedsReviewStatementRow => ({
  outcome: "needs-review",
  recordNumber: 1,
  reason: "mapping-unavailable",
  knownMoney: Option.none(),
  issues: [
    { path: "", message: `Statement mapping is unavailable.${" ".repeat(extraIssueBytes)}` },
  ],
  evidence: {
    sourceFormat: "csv",
    recordNumber: 1,
    startLine: 2,
    endLine: 2,
    rawRecord: raw,
    fields: [raw],
  },
});

it.each(["plain ASCII", 'é🙂\ud800x\udfff"\\\n\r\t\b\f\u0000'])(
  "counts complete record overhead and escaped UTF-8 exactly for %j",
  (suffix) => {
    const prefix = "\u0001".repeat(165_000) + suffix;
    const empty = Schema.encodeUnknownSync(evidenceCodec)(reviewRow("", 0).evidence);
    // The independent JSON encoder supplies bounded fixture sizes. Fixed UUIDs, timestamps,
    // metadata and SQLite record overhead leave 1,999,706 bytes for this evidence value.
    const requiredPayload = (1_999_706 - encodedLength(empty)) / 2;
    const raw = prefix + "x".repeat(requiredPayload - (encodedLength(prefix) - 2));
    const admits = statementReviewAdmission(context);
    for (const [extra, expected] of [
      [0, true],
      [1, true],
      [2, false],
    ] as const) {
      const row = reviewRow(raw, extra);
      expect(encodedLength(Schema.encodeUnknownSync(evidenceCodec)(row.evidence))).toBe(1_999_706);
      expect(encodedLength(row.issues)).toBe(59 + extra);
      // The resulting complete records are 1,999,999 / 2,000,000 / 2,000,001 bytes.
      expect(admits(row)).toBe(expected);
    }
  }
);

it("counts XLSX optional formula and display metadata without dropping repeated values", () => {
  const admits = statementReviewAdmission({ ...context, sourceFormat: "xlsx" });
  const row: NeedsReviewStatementRow = {
    ...reviewRow("", 0),
    evidence: {
      sourceFormat: "xlsx",
      sheetName: "Statement",
      sheetIndex: 0,
      rowNumber: 2,
      hidden: false,
      cells: [
        {
          address: "A2",
          cellType: "string",
          value: "é🙂",
          formattedText: Option.some("é🙂"),
          numberFormat: Option.some('"x"\\'),
          formula: Option.some("x".repeat(2_000_000)),
        },
      ],
    },
  };
  expect(admits(row)).toBe(false);
  if (row.evidence.sourceFormat !== "xlsx") throw new Error("Expected XLSX evidence");
  const evidence = row.evidence;
  expect(
    admits({
      ...row,
      evidence: {
        ...evidence,
        cells: evidence.cells.map((cell) => ({ ...cell, formula: Option.none() })),
      },
    })
  ).toBe(true);
});

it("charges actual UTF-8 metadata without a fixed safety reserve", () => {
  const raw = "\u0001".repeat(166_000) + "x".repeat(3_806);
  const row = reviewRow(raw, 0);
  expect(statementReviewAdmission({ ...context, locale: "es-COx" })(row)).toBe(true);
  expect(statementReviewAdmission({ ...context, locale: "es-COé" })(row)).toBe(false);
  // Zero uses the zero-byte integer serial type, freeing six bytes from a timestamp.
  expect(statementReviewAdmission({ ...context, createdAt: 0 })(reviewRow(raw, 7))).toBe(true);
  expect(statementReviewAdmission({ ...context, createdAt: 0 })(reviewRow(raw, 8))).toBe(false);
});
