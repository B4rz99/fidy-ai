import { expect, it } from "@effect/vitest";
import { Result, Schema } from "effect";
import {
  type CsvRowEvidence,
  NeedsReviewItem,
  NeedsReviewReason,
  NeedsReviewStatus,
  ParsedStatementRow,
  StagedStatementReference,
  StatementAccounting,
  StatementFailureReason,
  StatementRowEvidence,
  StatementSubmission,
  StatementSubmissionStatus,
  SubmitForExtractionInput,
  XlsxCellEvidence,
  type XlsxRowEvidence,
  maximumStatementBytes,
} from "./model";

const timestamp = "2026-08-01T12:00:00Z";
const submissionId = "f1d1a000-0000-4000-8000-000000000401";
const reviewId = "f1d1a000-0000-4000-8000-000000000402";
const transactionId = "f1d1a000-0000-4000-8000-000000000403";
const idempotencyKey = "20000000-0000-4000-8000-000000000201";
const stagingId = "30000000-0000-4000-8000-000000000301";

it("keeps the canonical submission input to one bounded staged reference", () => {
  const decode = Schema.decodeUnknownResult(SubmitForExtractionInput);
  const reference = { byteLength: 42, sha256: "a".repeat(64), stagingId };
  const decoded = decode({ idempotencyKey, reference });
  expect(Result.isSuccess(decoded)).toBe(true);
  if (Result.isSuccess(decoded)) {
    // Only the retry key and the reference survive decoding: a name, media type, format, or byte
    // claim sent alongside them is dropped rather than carried into publication.
    expect(Object.keys(decoded.success).sort()).toEqual(["idempotencyKey", "reference"]);
    expect(decoded.success.reference).toEqual(reference);
  }
  for (const invalid of [
    { idempotencyKey: "not-a-uuid", reference },
    { idempotencyKey, reference: { ...reference, byteLength: 0 } },
    { idempotencyKey, reference: { ...reference, byteLength: maximumStatementBytes + 1 } },
    { idempotencyKey, reference: { ...reference, sha256: "A".repeat(64) } },
    { idempotencyKey, reference: { ...reference, stagingId: "not-a-uuid" } },
    { idempotencyKey, reference: { ...reference, byteLength: 1.5 } },
  ]) {
    expect(Result.isFailure(decode(invalid))).toBe(true);
  }
  expect(Result.isSuccess(Schema.decodeResult(StagedStatementReference)(reference))).toBe(true);
});

it("accepts every public statement lifecycle and conserves its accounting", () => {
  const decodeSubmission = Schema.decodeUnknownResult(StatementSubmission);
  const common = {
    id: submissionId,
    sourceFormat: "csv",
    parserRevision: "parser-v1",
    submittedAt: timestamp,
  };
  const variants = [
    { ...common, status: "queued" },
    { ...common, status: "processing", startedAt: timestamp },
    {
      ...common,
      status: "completed",
      startedAt: timestamp,
      completedAt: "2026-08-01T12:01:00Z",
      accounting: { inputRows: 3, acceptedRows: 1, needsReviewRows: 2 },
    },
    {
      ...common,
      status: "failed",
      startedAt: timestamp,
      completedAt: "2026-08-01T12:01:00Z",
      failureReason: "malformed-file",
    },
  ];

  for (const variant of variants) {
    expect(Result.isSuccess(decodeSubmission(variant))).toBe(true);
  }
  expect(
    Result.isSuccess(
      Schema.decodeResult(StatementAccounting)({
        inputRows: 4,
        acceptedRows: 4,
        needsReviewRows: 0,
      })
    )
  ).toBe(true);
  const invalidAccounting = Schema.decodeResult(StatementAccounting)({
    inputRows: 3,
    acceptedRows: 1,
    needsReviewRows: 1,
  });
  expect(Result.isFailure(invalidAccounting)).toBe(true);
  expect(Result.isFailure(invalidAccounting) ? String(invalidAccounting.failure) : "").toContain(
    "inputRows"
  );

  for (const value of ["queued", "processing", "completed", "failed"]) {
    expect(Result.isSuccess(Schema.decodeUnknownResult(StatementSubmissionStatus)(value))).toBe(
      true
    );
  }
  for (const value of [
    "unsupported-format",
    "resource-limit",
    "malformed-file",
    "mapping-unavailable",
    "retention-expired",
  ]) {
    expect(Result.isSuccess(Schema.decodeUnknownResult(StatementFailureReason)(value))).toBe(true);
  }
});

it("accepts both parser evidence shapes", () => {
  const csv: typeof CsvRowEvidence.Encoded = {
    sourceFormat: "csv",
    recordNumber: 1,
    startLine: 2,
    endLine: 2,
    rawRecord: "date;amount",
    fields: ["2026-08-01", "10"],
  };
  const xlsx: typeof XlsxRowEvidence.Encoded = {
    sourceFormat: "xlsx",
    sheetName: "Statement",
    sheetIndex: 0,
    rowNumber: 2,
    hidden: false,
    cells: [
      {
        address: "A2",
        cellType: "string",
        value: "2026-08-01",
      },
    ],
  };

  expect(Result.isSuccess(Schema.decodeResult(StatementRowEvidence)(csv))).toBe(true);
  expect(Result.isSuccess(Schema.decodeResult(StatementRowEvidence)(xlsx))).toBe(true);
  expect(
    Result.isSuccess(
      Schema.decodeResult(XlsxCellEvidence)({
        address: "B2",
        cellType: "number",
        value: "10",
        formattedText: "10.00",
      })
    )
  ).toBe(true);
});

it("requires ParsedStatementRow facts to match its CSV evidence", () => {
  const evidence: typeof CsvRowEvidence.Encoded = {
    sourceFormat: "csv",
    recordNumber: 1,
    startLine: 2,
    endLine: 2,
    rawRecord: "date;amount",
    fields: ["2026-08-01", "10"],
  };
  const decode = Schema.decodeUnknownResult(ParsedStatementRow);

  expect(
    Result.isSuccess(decode({ recordNumber: 1, fields: ["2026-08-01", "10"], evidence }))
  ).toBe(true);
  const mismatchedFields = decode({
    recordNumber: 1,
    fields: ["2026-08-01", "11"],
    evidence,
  });
  expect(Result.isFailure(mismatchedFields)).toBe(true);
  expect(Result.isFailure(mismatchedFields) ? String(mismatchedFields.failure) : "").toContain(
    "evidence"
  );
  expect(Result.isFailure(decode({ recordNumber: 1, fields: ["2026-08-01"], evidence }))).toBe(
    true
  );

  const xlsxEvidence: typeof XlsxRowEvidence.Encoded = {
    sourceFormat: "xlsx",
    sheetName: "Statement",
    sheetIndex: 0,
    rowNumber: 2,
    hidden: false,
    cells: [],
  };
  expect(
    Result.isSuccess(decode({ recordNumber: 1, fields: ["2026-08-01"], evidence: xlsxEvidence }))
  ).toBe(true);
});

it("keeps NeedsReviewItem lifecycle evidence and format consistent", () => {
  const csvEvidence: typeof CsvRowEvidence.Encoded = {
    sourceFormat: "csv",
    recordNumber: 1,
    startLine: 2,
    endLine: 2,
    rawRecord: "date;amount",
    fields: ["2026-08-01", "10"],
  };
  const xlsxEvidence: typeof XlsxRowEvidence.Encoded = {
    sourceFormat: "xlsx",
    sheetName: "Statement",
    sheetIndex: 0,
    rowNumber: 2,
    hidden: false,
    cells: [],
  };
  const common = {
    id: reviewId,
    submissionId,
    recordNumber: 1,
    reason: "missing-required-fact",
    serviceMarket: "CO",
    locale: "es-CO",
    timeZone: "America/Bogota",
    sourceFormat: "csv",
    sourceChannel: "statement-upload",
    parserRevision: "parser-v1",
    extractorRevision: "extractor-v1",
    issues: [{ path: "amount", message: "missing" }],
    createdAt: timestamp,
  };
  const decode = Schema.decodeUnknownResult(NeedsReviewItem);

  expect(
    Result.isSuccess(decode({ ...common, status: "pending", originalEvidence: csvEvidence }))
  ).toBe(true);
  const mismatchedEvidence = decode({
    ...common,
    status: "pending",
    originalEvidence: xlsxEvidence,
  });
  expect(Result.isFailure(mismatchedEvidence)).toBe(true);
  expect(Result.isFailure(mismatchedEvidence) ? String(mismatchedEvidence.failure) : "").toContain(
    "sourceFormat"
  );
  expect(Result.isSuccess(decode({ ...common, status: "expired" }))).toBe(true);
  expect(
    Result.isSuccess(
      decode({
        ...common,
        status: "resolved",
        transactionId,
        resolvedAt: "2026-08-02T12:00:00Z",
      })
    )
  ).toBe(true);

  for (const value of ["pending", "expired", "resolved"]) {
    expect(Result.isSuccess(Schema.decodeUnknownResult(NeedsReviewStatus)(value))).toBe(true);
  }
  for (const value of [
    "malformed-source-row",
    "missing-required-fact",
    "ambiguous-direction",
    "ambiguous-currency",
    "canonical-validation-failed",
    "mapping-unavailable",
  ]) {
    expect(Result.isSuccess(Schema.decodeUnknownResult(NeedsReviewReason)(value))).toBe(true);
  }
});
