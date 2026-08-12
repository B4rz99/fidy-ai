import { Option, Schema } from "effect";
import { IanaTimeZone, Locale, ServiceMarket } from "~/core/_shared/context";
import { Money } from "~/core/_shared/money";
import { UtcTimestamp } from "~/core/_shared/time";
import { TransactionId } from "~/core/transactions/reference";
import { NeedsReviewItemId, StatementSourceFormat, StatementSubmissionId } from "./reference";

const maximumEncodedFileLength = 6_990_508;
const maximumFileNameLength = 255;
const maximumMappingSampleRows = 5;

/** Declared media types accepted at the upload boundary; byte sniffing remains authoritative. */
export const StatementMediaType = Schema.Literals([
  "text/csv",
  "application/csv",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
]);

/** Bounded encoded statement bytes transported through canonical JSON operations. */
export const Base64FileContent = Schema.String.check(
  Schema.isPattern(/^[A-Za-z0-9+/]*={0,2}$/u),
  Schema.isMaxLength(maximumEncodedFileLength)
).pipe(Schema.brand("Base64FileContent"));

/** A caller-generated key identifying one logical statement submission. */
export const StatementIdempotencyKey = Schema.String.check(Schema.isUUID()).pipe(
  Schema.brand("StatementIdempotencyKey")
);
export type StatementIdempotencyKey = typeof StatementIdempotencyKey.Type;

/** The bounded file and retry identity required to queue one statement. */
export const SubmitForExtractionInput = Schema.Struct({
  idempotencyKey: StatementIdempotencyKey,
  file: Schema.Struct({
    name: Schema.NonEmptyString.check(
      Schema.isTrimmed(),
      Schema.isMaxLength(maximumFileNameLength)
    ),
    declaredMediaType: StatementMediaType,
    contentBase64: Base64FileContent,
  }),
}).annotate({ identifier: "SubmitForExtractionInput" });
export type SubmitForExtractionInput = typeof SubmitForExtractionInput.Type;

/** User interpretation facts frozen when a statement is admitted. */
export const CapturedStatementContext = Schema.Struct({
  serviceMarket: ServiceMarket,
  locale: Locale,
  timeZone: IanaTimeZone,
}).annotate({ identifier: "CapturedStatementContext" });
export type CapturedStatementContext = typeof CapturedStatementContext.Type;

const StatementAccountingFields = Schema.Struct({
  inputRows: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  acceptedRows: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  needsReviewRows: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
});
const conservedStatementRows = Schema.makeFilter<typeof StatementAccountingFields.Type>((counts) =>
  counts.inputRows === counts.acceptedRows + counts.needsReviewRows
    ? undefined
    : { path: ["inputRows"], issue: "Expected acceptedRows plus needsReviewRows" }
);

/** Conserved final counts for every parsed statement row. */
export const StatementAccounting = StatementAccountingFields.check(conservedStatementRows).annotate(
  { identifier: "StatementAccounting" }
);
export type StatementAccounting = typeof StatementAccounting.Type;

/** Durable processing states exposed while a statement moves through the worker. */
export const StatementSubmissionStatus = Schema.Literals([
  "queued",
  "processing",
  "completed",
  "failed",
]);
/** Safe terminal classifications that never expose parser or provider internals. */
export const StatementFailureReason = Schema.Literals([
  "unsupported-format",
  "resource-limit",
  "malformed-file",
  "mapping-unavailable",
  "retention-expired",
]);

const StatementSubmissionBase = Schema.Struct({
  id: StatementSubmissionId,
  sourceFormat: StatementSourceFormat,
  parserRevision: Schema.NonEmptyString,
  submittedAt: UtcTimestamp,
});

/** Durable public lifecycle of one idempotent statement extraction request. */
export const StatementSubmission = Schema.Union([
  Schema.Struct({ ...StatementSubmissionBase.fields, status: Schema.Literal("queued") }),
  Schema.Struct({
    ...StatementSubmissionBase.fields,
    status: Schema.Literal("processing"),
    startedAt: UtcTimestamp,
  }),
  Schema.Struct({
    ...StatementSubmissionBase.fields,
    status: Schema.Literal("completed"),
    startedAt: UtcTimestamp,
    completedAt: UtcTimestamp,
    accounting: StatementAccounting,
  }),
  Schema.Struct({
    ...StatementSubmissionBase.fields,
    status: Schema.Literal("failed"),
    startedAt: UtcTimestamp,
    completedAt: UtcTimestamp,
    failureReason: StatementFailureReason,
  }),
]).annotate({ identifier: "StatementSubmission" });
export type StatementSubmission = typeof StatementSubmission.Type;

/** Parser-produced original CSV evidence retained only while its row awaits review. */
export const CsvRowEvidence = Schema.Struct({
  sourceFormat: Schema.Literal("csv"),
  recordNumber: Schema.Int.check(Schema.isGreaterThan(0)),
  startLine: Schema.Int.check(Schema.isGreaterThan(0)),
  endLine: Schema.Int.check(Schema.isGreaterThan(0)),
  rawRecord: Schema.String,
  fields: Schema.Array(Schema.String),
});

/** Direct XLSX cell evidence, including display and formula metadata without evaluation. */
export const XlsxCellEvidence = Schema.Struct({
  address: Schema.NonEmptyString,
  cellType: Schema.Literals(["blank", "string", "number", "date", "boolean", "error"]),
  value: Schema.String,
  formattedText: Schema.OptionFromOptionalKey(Schema.String),
  numberFormat: Schema.OptionFromOptionalKey(Schema.String),
  formula: Schema.OptionFromOptionalKey(Schema.String),
});
export type XlsxCellEvidence = typeof XlsxCellEvidence.Type;

/** Parser-produced original XLSX row evidence retained only while review is pending. */
export const XlsxRowEvidence = Schema.Struct({
  sourceFormat: Schema.Literal("xlsx"),
  sheetName: Schema.NonEmptyString,
  sheetIndex: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  rowNumber: Schema.Int.check(Schema.isGreaterThan(0)),
  hidden: Schema.Boolean,
  cells: Schema.Array(XlsxCellEvidence),
});

/** Parser-neutral evidence for a single rejected source row. */
export const StatementRowEvidence = Schema.Union([CsvRowEvidence, XlsxRowEvidence]);
export type StatementRowEvidence = typeof StatementRowEvidence.Type;

/** Stable mechanical classifications explaining why a row was not captured. */
export const NeedsReviewReason = Schema.Literals([
  "malformed-source-row",
  "missing-required-fact",
  "ambiguous-direction",
  "ambiguous-currency",
  "canonical-validation-failed",
  "mapping-unavailable",
]);
export type NeedsReviewReason = typeof NeedsReviewReason.Type;

/** A safe field-local explanation attached to a review item. */
export const CapturedFieldIssue = Schema.Struct({
  path: Schema.String,
  message: Schema.String,
});

const NeedsReviewBase = Schema.Struct({
  id: NeedsReviewItemId,
  submissionId: StatementSubmissionId,
  recordNumber: Schema.Int.check(Schema.isGreaterThan(0)),
  reason: NeedsReviewReason,
  knownMoney: Schema.OptionFromOptionalKey(Money),
  ...CapturedStatementContext.fields,
  sourceFormat: StatementSourceFormat,
  sourceChannel: Schema.Literal("statement-upload"),
  sourceProvider: Schema.OptionFromOptionalKey(Schema.NonEmptyString),
  parserRevision: Schema.NonEmptyString,
  extractorRevision: Schema.NonEmptyString,
  issues: Schema.Array(CapturedFieldIssue),
  createdAt: UtcTimestamp,
});

/** Review lifecycle: actionable with evidence, evidence-expired, or canonically resolved. */
export const NeedsReviewStatus = Schema.Literals(["pending", "expired", "resolved"]);

const NeedsReviewItemVariants = Schema.Union([
  Schema.Struct({
    ...NeedsReviewBase.fields,
    status: Schema.Literal("pending"),
    originalEvidence: StatementRowEvidence,
  }),
  Schema.Struct({
    ...NeedsReviewBase.fields,
    status: Schema.Literal("expired"),
  }),
  Schema.Struct({
    ...NeedsReviewBase.fields,
    status: Schema.Literal("resolved"),
    transactionId: TransactionId,
    resolvedAt: UtcTimestamp,
  }),
]);
const matchingReviewEvidenceFormat = Schema.makeFilter<typeof NeedsReviewItemVariants.Type>(
  (item) =>
    item.status !== "pending" || item.sourceFormat === item.originalEvidence.sourceFormat
      ? undefined
      : { path: ["sourceFormat"], issue: "Expected the original evidence format" }
);

/** A visible rejected row; raw evidence expires independently while lifecycle metadata remains. */
export const NeedsReviewItem = NeedsReviewItemVariants.check(matchingReviewEvidenceFormat).annotate(
  {
    identifier: "NeedsReviewItem",
  }
);
export type NeedsReviewItem = typeof NeedsReviewItem.Type;

const StatementColumnMappingFields = Schema.Struct({
  dateColumn: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  amountColumn: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  counterpartyColumn: Schema.OptionFromOptionalKey(
    Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))
  ),
  currencyColumn: Schema.OptionFromOptionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
  currencyLiteral: Schema.OptionFromOptionalKey(Money.fields.currency),
  directionColumn: Schema.OptionFromOptionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
  inflowMarkers: Schema.Array(Schema.String),
  outflowMarkers: Schema.Array(Schema.String),
  positiveDirection: Schema.Literals(["inflow", "outflow"]),
  dateFormat: Schema.Literals(["yyyy-MM-dd", "dd/MM/yyyy", "MM/dd/yyyy"]),
  decimalSeparator: Schema.Literals([".", ","]),
  groupingSeparator: Schema.OptionFromOptionalKey(Schema.Literals([".", ",", " ", "'"])),
});
const validStatementColumnStrategies = Schema.makeFilter<typeof StatementColumnMappingFields.Type>(
  (mapping) => {
    if (Option.isSome(mapping.currencyColumn) === Option.isSome(mapping.currencyLiteral)) {
      return { path: ["currencyColumn"], issue: "Expected exactly one Currency source" };
    }
    if (
      Option.isNone(mapping.directionColumn) &&
      (mapping.inflowMarkers.length > 0 || mapping.outflowMarkers.length > 0)
    ) {
      return { path: ["directionColumn"], issue: "Expected a column when markers are configured" };
    }
    return undefined;
  }
);

/**
 * One model-derived, reusable tabular format. Column indexes are zero-based. Currency is sourced
 * from exactly one column or literal; direction markers are meaningful only with a direction column.
 */
export const StatementColumnMapping = StatementColumnMappingFields.check(
  validStatementColumnStrategies
).annotate({ identifier: "StatementColumnMapping" });
export type StatementColumnMapping = typeof StatementColumnMapping.Type;

const ParsedStatementRowFields = Schema.Struct({
  recordNumber: Schema.Int.check(Schema.isGreaterThan(0)),
  fields: Schema.Array(Schema.String),
  evidence: StatementRowEvidence,
});
const matchingCsvRowEvidence = Schema.makeFilter<typeof ParsedStatementRowFields.Type>((row) => {
  const evidence = row.evidence;
  if (evidence.sourceFormat !== "csv") return undefined;
  return row.recordNumber === evidence.recordNumber &&
    row.fields.length === evidence.fields.length &&
    row.fields.every((field, index) => field === evidence.fields[index])
    ? undefined
    : { path: ["evidence"], issue: "Expected matching parsed CSV row facts" };
});

/** Parser-neutral row passed into deterministic mechanical interpretation. */
export const ParsedStatementRow = ParsedStatementRowFields.check(matchingCsvRowEvidence);
export type ParsedStatementRow = typeof ParsedStatementRow.Type;

/** A parser row that deterministic interpretation could not safely accept. */
export type NeedsReviewStatementRow = Readonly<{
  outcome: "needs-review";
  recordNumber: number;
  reason: NeedsReviewReason;
  knownMoney: Option.Option<Money>;
  issues: ReadonlyArray<typeof CapturedFieldIssue.Type>;
  evidence: StatementRowEvidence;
}>;

/** The exhaustive accepted-or-review result of mechanical row interpretation. */
export type InterpretedStatementRow<Extraction> =
  | Readonly<{
      outcome: "accepted";
      recordNumber: number;
      extraction: Extraction;
      evidence: StatementRowEvidence;
    }>
  | NeedsReviewStatementRow;

/** The bounded table shape sent in one structured mapping request. */
export const StatementMappingSample = Schema.Struct({
  sourceFormat: StatementSourceFormat,
  headers: Schema.NonEmptyArray(Schema.String),
  sampleRows: Schema.Array(Schema.Array(Schema.String)).check(
    Schema.isMaxLength(maximumMappingSampleRows)
  ),
});
export type StatementMappingSample = typeof StatementMappingSample.Type;
