import { DateTime, Option, Schema } from "effect";
import { CapturedInterpretationContext } from "~/core/_shared/captured-interpretation-context";
import { ServiceMarket } from "~/core/_shared/context";
import { InterpretationRevision } from "~/core/_shared/interpretation-revision";
import { Money } from "~/core/_shared/money";
import { ProviderMessageEvidence } from "~/core/_shared/provider-message-evidence";
import { UtcTimestamp } from "~/core/_shared/time";
import { TransactionId } from "~/core/transactions/reference";
import {
  maximumEmailAddressCharacters,
  maximumEmailEvidenceIdCharacters,
  maximumEmailHtmlCharacters,
  maximumEmailInlineImages,
  maximumEmailRecipients,
  maximumEmailSubjectCharacters,
  maximumEmailTextCharacters,
} from "./email-policy";
import {
  EmailForwardingAddressId,
  EmailSourceFormat,
  IngestSampleId,
  NeedsReviewItemId,
  ResendReceivedEmailId,
  StatementSourceFormat,
  StatementSubmissionId,
} from "./reference";

const maximumEncodedFileLength = 6_990_508;
const maximumFileNameLength = 255;
const maximumMappingSampleRows = 5;

/** One permanent unpredictable forwarding address owned by the authenticated User. */
export const EmailForwardingAddress = Schema.Struct({
  id: EmailForwardingAddressId,
  address: Schema.NonEmptyString.check(
    Schema.isTrimmed(),
    Schema.isMaxLength(maximumEmailAddressCharacters)
  ),
  createdAt: UtcTimestamp,
}).annotate({ identifier: "EmailForwardingAddress" });
export type EmailForwardingAddress = typeof EmailForwardingAddress.Type;

/** Current Colombia-month allowance and deferred work visible beside the forwarding address. */
export const EmailForwardingStatus = Schema.Struct({
  address: Schema.OptionFromOptionalKey(EmailForwardingAddress),
  remainingThisMonth: Schema.OptionFromOptionalKey(
    Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 50 }))
  ),
  deferredEmails: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 50 })),
  deferredCapacityRemaining: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 50 })),
  resetsAt: UtcTimestamp,
}).annotate({ identifier: "EmailForwardingStatus" });
export type EmailForwardingStatus = typeof EmailForwardingStatus.Type;

/** Bounded inline image bytes referenced from received HTML; ordinary attachments are excluded. */
export const ReceivedInlineImage = Schema.Struct({
  contentId: Schema.NonEmptyString.check(
    Schema.isTrimmed(),
    Schema.isMaxLength(maximumEmailEvidenceIdCharacters)
  ),
  mediaType: Schema.Literals(["image/jpeg", "image/png", "image/gif", "image/webp"]),
  content: Schema.Uint8Array,
});
export type ReceivedInlineImage = typeof ReceivedInlineImage.Type;

/** Closed Resend projection retained as raw personal evidence for a configured 90 days. */
export const ReceivedEmailContent = Schema.Struct({
  receivedEmailId: ResendReceivedEmailId,
  from: Schema.String.check(Schema.isMaxLength(maximumEmailAddressCharacters)),
  to: Schema.Array(Schema.String.check(Schema.isMaxLength(maximumEmailAddressCharacters))).check(
    Schema.isMaxLength(maximumEmailRecipients)
  ),
  subject: Schema.String.check(Schema.isMaxLength(maximumEmailSubjectCharacters)),
  text: Schema.OptionFromOptionalKey(
    Schema.String.check(Schema.isMaxLength(maximumEmailTextCharacters))
  ),
  html: Schema.OptionFromOptionalKey(
    Schema.String.check(Schema.isMaxLength(maximumEmailHtmlCharacters))
  ),
  inlineImages: Schema.Array(ReceivedInlineImage).check(
    Schema.isMaxLength(maximumEmailInlineImages)
  ),
  messageId: Schema.OptionFromOptionalKey(
    Schema.String.check(Schema.isMaxLength(maximumEmailEvidenceIdCharacters))
  ),
  createdAt: UtcTimestamp,
}).annotate({ identifier: "ReceivedEmailContent" });
export type ReceivedEmailContent = typeof ReceivedEmailContent.Type;

const RawEmailIngestSampleFields = Schema.Struct({
  id: IngestSampleId,
  receivedEmailId: ResendReceivedEmailId,
  ...CapturedInterpretationContext.fields,
  sourceFormat: EmailSourceFormat,
  sourceProvider: Schema.Literal("resend"),
  parserRevision: InterpretationRevision,
  content: ReceivedEmailContent,
  retainedAt: UtcTimestamp,
  expiresAt: UtcTimestamp,
});
const validRawEmailRetention = Schema.makeFilter<
  Readonly<Pick<typeof RawEmailIngestSampleFields.Type, "retainedAt" | "expiresAt">>
>((sample) =>
  DateTime.toEpochMillis(sample.retainedAt) < DateTime.toEpochMillis(sample.expiresAt)
    ? undefined
    : { path: ["expiresAt"], issue: "Expected expiry after retention" }
);

/** Raw personal IngestSample retained only until its explicit expiry. */
export const RawEmailIngestSample = RawEmailIngestSampleFields.check(
  validRawEmailRetention
).annotate({ identifier: "RawEmailIngestSample" });
export type RawEmailIngestSample = typeof RawEmailIngestSample.Type;

/** Operator-approved, User-unlinked structural evidence eligible for indefinite retention. */
export const AnonymizedEmailIngestSample = Schema.Struct({
  id: IngestSampleId,
  serviceMarket: ServiceMarket,
  sourceFormat: EmailSourceFormat,
  sourceProvider: Schema.Literal("resend"),
  parserRevision: InterpretationRevision,
  anonymizationRevision: InterpretationRevision,
  structure: Schema.NonEmptyString,
  approvedAt: UtcTimestamp,
  retainedAt: UtcTimestamp,
}).annotate({ identifier: "AnonymizedEmailIngestSample" });
export type AnonymizedEmailIngestSample = typeof AnonymizedEmailIngestSample.Type;

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

/** Durable public lifecycle after one statement submission is accepted. */
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
  "model-unavailable",
]);
export type NeedsReviewReason = typeof NeedsReviewReason.Type;

/** Stable classifications for notification emails that could not be safely captured. */
export const EmailNeedsReviewReason = Schema.Literals([
  "model-unavailable",
  "canonical-validation-failed",
  "provider-retrieval-failed",
  "processing-interrupted",
]);
export type EmailNeedsReviewReason = typeof EmailNeedsReviewReason.Type;

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
  ...CapturedInterpretationContext.fields,
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

/** A visible rejected statement row; raw evidence expires independently. */
export const StatementNeedsReviewItem = NeedsReviewItemVariants.check(
  matchingReviewEvidenceFormat
).annotate({ identifier: "StatementNeedsReviewItem" });
export type StatementNeedsReviewItem = typeof StatementNeedsReviewItem.Type;

const EmailNeedsReviewFields = {
  id: NeedsReviewItemId,
  receivedEmailId: ResendReceivedEmailId,
  reason: EmailNeedsReviewReason,
  knownMoney: Schema.OptionFromOptionalKey(Money),
  ...CapturedInterpretationContext.fields,
  sourceFormat: EmailSourceFormat,
  sourceChannel: Schema.Literal("forwarded-email"),
  sourceProvider: Schema.Literal("resend"),
  messageEvidence: ProviderMessageEvidence,
  parserRevision: InterpretationRevision,
  extractorRevision: InterpretationRevision,
  issues: Schema.Array(CapturedFieldIssue),
  createdAt: UtcTimestamp,
} as const;

/** A visible notification email that could not safely become a canonical Transaction. */
export const EmailNeedsReviewItem = Schema.Union([
  Schema.Struct({
    ...EmailNeedsReviewFields,
    reason: Schema.Literals(["model-unavailable", "canonical-validation-failed"]),
    ingestSampleId: IngestSampleId,
    status: Schema.Literal("pending"),
  }),
  Schema.Struct({
    ...EmailNeedsReviewFields,
    reason: Schema.Literals(["provider-retrieval-failed", "processing-interrupted"]),
    status: Schema.Literal("pending"),
  }),
  Schema.Struct({ ...EmailNeedsReviewFields, status: Schema.Literal("expired") }),
]).annotate({ identifier: "EmailNeedsReviewItem" });
export type EmailNeedsReviewItem = typeof EmailNeedsReviewItem.Type;

/** Every visible Ingestion outcome requiring User review, independent of source channel. */
export const NeedsReviewItem = Schema.Union([
  StatementNeedsReviewItem,
  EmailNeedsReviewItem,
]).annotate({ identifier: "NeedsReviewItem" });
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

/** Raw headers and at most five raw rows sent once to map an unknown statement format. */
export const StatementMappingSample = Schema.Struct({
  sourceFormat: StatementSourceFormat,
  headers: Schema.NonEmptyArray(Schema.String),
  sampleRows: Schema.Array(Schema.Array(Schema.String)).check(
    Schema.isMaxLength(maximumMappingSampleRows)
  ),
});
export type StatementMappingSample = typeof StatementMappingSample.Type;
