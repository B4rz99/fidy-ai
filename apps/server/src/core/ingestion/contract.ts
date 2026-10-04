import { freeAllowanceLimits } from "~/core/quotas/contract";
import { Option, Schema, Struct } from "effect";
import {
  CapturedInterpretationContext,
  InterpretationRevision,
} from "~/core/interpretation-evidence/contract";
import { Money } from "~/core/_shared/money";
import { ProviderMessageEvidence } from "~/core/provider-evidence/contract";
import { UtcTimestamp } from "~/core/_shared/time";
import { TransactionExtraction, TransactionId } from "~/core/transactions/contract";

/**
 * An explicit source instant or normalized local date, interpreted in captured context. An absent
 * local time means the start of that source date; invalid calendar dates and ambiguous local times
 * still require policy review. The containing proposal models absence of the entire occurrence.
 */
export const CaptureOccurrence = Schema.Union([
  Schema.TaggedStruct("Instant", { value: UtcTimestamp }),
  Schema.TaggedStruct("LocalDate", {
    date: Schema.String.check(
      Schema.isPattern(/^[0-9]{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12][0-9]|3[01])$/u)
    ),
    time: Schema.OptionFromOptionalKey(
      Schema.String.check(Schema.isPattern(/^(?:[01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9]$/u))
    ),
  }),
]).annotate({ identifier: "CaptureOccurrence" });
export type CaptureOccurrence = typeof CaptureOccurrence.Type;

/**
 * Facts proposed by bounded image/text inference, not yet eligible for Transaction capture. Money
 * may omit Currency, and its proposed shape does not imply canonical precision or positivity;
 * interpretation must apply defaults and revalidate the complete TransactionExtraction.
 */
export const CaptureProposal = Schema.Union([
  Schema.TaggedStruct("SingleMovement", {
    completion: Schema.Literals(["completed", "pending", "rejected", "cancelled", "unclear"]),
    money: Schema.OptionFromOptionalKey(
      Money.mapFields(
        Struct.evolve({ currency: () => Schema.OptionFromOptionalKey(Money.fields.currency) })
      )
    ),
    direction: Schema.OptionFromOptionalKey(TransactionExtraction.fields.direction),
    counterparty: TransactionExtraction.fields.counterparty,
    occurrence: Schema.OptionFromOptionalKey(CaptureOccurrence),
  }),
  Schema.TaggedStruct("MultipleMovements", {}),
  Schema.TaggedStruct("Unparseable", {}),
]).annotate({ identifier: "CaptureProposal" });
export type CaptureProposal = typeof CaptureProposal.Type;

/** Captured policy basis distinguishes source facts from applied defaults after raw material expires. */
export const CaptureInterpretationEvidence = Schema.Struct({
  currencyBasis: Schema.Literals(["explicit", "default"]),
  dateBasis: Schema.Literals(["explicit", "submission-date-default"]),
  revision: InterpretationRevision,
}).annotate({ identifier: "CaptureInterpretationEvidence" });
export type CaptureInterpretationEvidence = typeof CaptureInterpretationEvidence.Type;

/** One image proposes at most one completed Transaction; uncertain material is always reviewable. */
export const CaptureInterpretation = Schema.Union([
  Schema.TaggedStruct("Extracted", {
    extraction: TransactionExtraction,
    evidence: CaptureInterpretationEvidence,
  }),
  Schema.TaggedStruct("NeedsReview", {
    reason: Schema.Literals([
      "unparseable-material",
      "multiple-movements",
      "movement-not-completed",
      "missing-required-fact",
      "canonical-validation-failed",
      "invalid-occurrence",
    ]),
  }),
]).annotate({ identifier: "CaptureInterpretation" });
export type CaptureInterpretation = typeof CaptureInterpretation.Type;

/** Already-decoded material and immutable context; now is the authoritative finalization instant. */
export type CaptureInterpretationInput = Readonly<{
  proposal: CaptureProposal;
  context: CapturedInterpretationContext;
  submittedAt: UtcTimestamp;
  now: UtcTimestamp;
}>;

/** Default interpretation policy is immutable in historical capture evidence. */
export const captureInterpretationRevision = InterpretationRevision.make("capture-v1");

/** Content and provider message identifiers are bounded metadata, never open-ended evidence. */
export const maximumEmailEvidenceIdCharacters = 256;
/** Delivery identifiers are bounded to replay verification input and evidence. */
export const maximumForwardedEmailDeliveryIdCharacters = 128;

/** Stable kind code for deterministic tabular statement formats. */
export const StatementSourceFormat = Schema.Literals(["csv", "xlsx"]);
export type StatementSourceFormat = typeof StatementSourceFormat.Type;

/** The only notification-email format interpreted by this direct Colombia launch slice. */
export const EmailSourceFormat = Schema.Literal("notification-email");
export type EmailSourceFormat = typeof EmailSourceFormat.Type;

/** Stable identity of one durable statement submission. */
export const StatementSubmissionId = Schema.String.check(Schema.isUUID())
  .pipe(Schema.brand("StatementSubmissionId"))
  .annotate({ identifier: "StatementSubmissionId" });
export type StatementSubmissionId = typeof StatementSubmissionId.Type;

/** Stable identity of one visible statement row awaiting or retaining resolution metadata. */
export const NeedsReviewItemId = Schema.String.check(Schema.isUUID())
  .pipe(Schema.brand("NeedsReviewItemId"))
  .annotate({ identifier: "NeedsReviewItemId" });
export type NeedsReviewItemId = typeof NeedsReviewItemId.Type;

/** Unpredictable mailbox token for one permanent User forwarding address. */
export const EmailForwardingLocalPart = Schema.String.check(
  Schema.isPattern(/^[a-z0-9_-]{24,64}$/u)
)
  .pipe(Schema.brand("EmailForwardingLocalPart"))
  .annotate({ identifier: "EmailForwardingLocalPart" });
export type EmailForwardingLocalPart = typeof EmailForwardingLocalPart.Type;

/** Stable identity of a User's one permanent forwarded-email address. */
export const EmailForwardingAddressId = Schema.String.check(Schema.isUUID())
  .pipe(Schema.brand("EmailForwardingAddressId"))
  .annotate({ identifier: "EmailForwardingAddressId" });
export type EmailForwardingAddressId = typeof EmailForwardingAddressId.Type;

/** Stable identity of one retained email IngestSample. */
export const IngestSampleId = Schema.String.check(Schema.isUUID())
  .pipe(Schema.brand("IngestSampleId"))
  .annotate({ identifier: "IngestSampleId" });
export type IngestSampleId = typeof IngestSampleId.Type;

/** Stable identity of one received forwarded email. */
export const ReceivedEmailId = Schema.NonEmptyString.check(
  Schema.isTrimmed(),
  Schema.isMaxLength(maximumEmailEvidenceIdCharacters)
).pipe(Schema.brand("ReceivedEmailId"));
export type ReceivedEmailId = typeof ReceivedEmailId.Type;

/** Stable identity of one authenticated email delivery, used only as replay evidence. */
export const ForwardedEmailDeliveryId = Schema.NonEmptyString.check(
  Schema.isTrimmed(),
  Schema.isMaxLength(maximumForwardedEmailDeliveryIdCharacters)
).pipe(Schema.brand("ForwardedEmailDeliveryId"));
export type ForwardedEmailDeliveryId = typeof ForwardedEmailDeliveryId.Type;

// Product and evidence bounds shared by the notification-email model and forwarded-email policy.
// Transport-only limits remain at their owning shell boundary.

/** Free receipt and screenshot extraction share two unique submissions per Bogotá calendar month. */
export const freeMediaSubmissionCap = freeAllowanceLimits.media_submission;

/** Issue #22 grants each Free User fifty unique notification emails per Bogotá calendar month. */
export const freeForwardedEmailCap = freeAllowanceLimits.forwarded_email;

/** One additional month of Free email can wait without making retained work unbounded. */
export const freeForwardedEmailDeferredCap = 50;

/** Current-month work plus one full deferred month bounds unfinished work for every User. */
export const forwardedEmailOutstandingCap = freeForwardedEmailCap + freeForwardedEmailDeferredCap;

/** Complete metadata and streamed inline-image retrieval must finish within this lease sub-window. */
export const forwardedEmailRetrievalDeadline = "3 minutes";

/** The theoretical local-part, separator, and DNS-name envelope-address maximum is 320 characters. */
export const maximumEmailAddressCharacters = 320;

/** Twenty recipients bounds one provider projection before any User address is resolved. */
export const maximumEmailRecipients = 20;

/** Internet Message Format permits at most 998 content characters on one unfolded line. */
export const maximumEmailSubjectCharacters = 998;

/** Plain text is limited to 256 KiB-equivalent characters before model projection. */
export const maximumEmailTextCharacters = 262_144;

/** HTML is allowed twice the plain-text budget because markup adds structural overhead. */
export const maximumEmailHtmlCharacters = 524_288;

/** Eight one-MiB images cap decoded inline-image bytes at eight MiB per notification email. */
export const maximumEmailInlineImages = 8;

/** Each inline image is bounded independently before interpretation. */
export const maximumEmailInlineImageBytes = 1_048_576;

/** Width and height are each capped at 4096; their product also bounds decoded pixel allocation. */
export const maximumEmailInlineImageDimension = 4_096;

const maximumStatementMebibytes = 5;
const bytesPerKibibyte = 1024;
const bytesPerMebibyte = bytesPerKibibyte * bytesPerKibibyte;

/**
 * Largest actual statement byte length accepted by staging or parsing. Staged bytes are exactly the
 * compressed input a later parse receives, so both ceilings are the same domain bound.
 */
export const maximumStatementBytes = maximumStatementMebibytes * bytesPerMebibyte;

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

/**
 * Opaque, unpredictable identity of one staged statement object. It is generated by the server
 * from cryptographic entropy and never derived from a UserId, filename, digest, or byte count, so
 * possessing it proves nothing about ownership and another User's reference cannot be guessed.
 */
export const StatementStagingId = Schema.String.check(Schema.isUUID())
  .pipe(Schema.brand("StatementStagingId"))
  .annotate({ identifier: "StatementStagingId" });
export type StatementStagingId = typeof StatementStagingId.Type;

/** Lowercase hexadecimal SHA-256 digest of the exact staged bytes. Not a secret. */
export const StatementContentDigest = Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/u))
  .pipe(Schema.brand("StatementContentDigest"))
  .annotate({ identifier: "StatementContentDigest" });
export type StatementContentDigest = typeof StatementContentDigest.Type;

/**
 * Non-authoritative acknowledgement of one staged object: identity, the actual received byte
 * length, the digest of those bytes, the mechanically sniffed format, and the server-owned expiry.
 * It is not a StatementSubmission and confers no eligibility for extraction; only D1 publication
 * creates authority.
 */
export const StagedStatementBytes = Schema.Struct({
  stagingId: StatementStagingId,
  byteLength: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: maximumStatementBytes })),
  sha256: StatementContentDigest,
  sourceFormat: StatementSourceFormat,
  expiresAt: UtcTimestamp,
}).annotate({ identifier: "StagedStatementBytes" });
export type StagedStatementBytes = typeof StagedStatementBytes.Type;

/**
 * Bounded caller-held handle to staged bytes, as it appears inside a canonical submission input.
 * Every field is verified against the stored staging row and the private R2 object before any
 * authoritative D1 state commits; a caller can neither shorten it nor point it at another User's
 * material. The format and retention stay server-owned and are deliberately absent here.
 */
export const StagedStatementReference = Schema.Struct({
  stagingId: StatementStagingId,
  byteLength: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: maximumStatementBytes })),
  sha256: StatementContentDigest,
}).annotate({ identifier: "StagedStatementReference" });
export type StagedStatementReference = typeof StagedStatementReference.Type;

/** A caller-generated key identifying one logical statement submission. */
export const StatementIdempotencyKey = Schema.String.check(Schema.isUUID()).pipe(
  Schema.brand("StatementIdempotencyKey")
);
export type StatementIdempotencyKey = typeof StatementIdempotencyKey.Type;

/** The staged-material reference and retry identity required to queue one statement. */
export const SubmitForExtractionInput = Schema.Struct({
  idempotencyKey: StatementIdempotencyKey,
  reference: StagedStatementReference,
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

/** Conserved finalized-row counts. For a failed submission with partial progress, inputRows is
 * the processed subset, not the total number of rows in the staged file. */
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
    accounting: Schema.optionalKey(StatementAccounting),
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

/** Closed deterministic interpretation outcomes that are safe to persist and expose. */
export const NotificationEmailInterpretationReviewReason = Schema.Literals([
  "unsupported-content",
  "unknown-format",
  "ambiguous-format",
  "invalid-format",
]);
export type NotificationEmailInterpretationReviewReason =
  typeof NotificationEmailInterpretationReviewReason.Type;

/** Review reasons backed by a retained bounded raw IngestSample. */
export const EmailRawSampleReviewReason = Schema.Union([
  Schema.Literal("canonical-validation-failed"),
  NotificationEmailInterpretationReviewReason,
]);
export type EmailRawSampleReviewReason = typeof EmailRawSampleReviewReason.Type;

/** Review reasons that have no retained raw IngestSample. */
export const EmailNoSampleReviewReason = Schema.Literals([
  "provider-retrieval-failed",
  "processing-interrupted",
  "consent-revoked",
]);
export type EmailNoSampleReviewReason = typeof EmailNoSampleReviewReason.Type;

/** Stable classifications for notification emails that could not be safely captured. */
export const EmailNeedsReviewReason = Schema.Union([
  EmailRawSampleReviewReason,
  EmailNoSampleReviewReason,
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
  receivedEmailId: ReceivedEmailId,
  reason: EmailNeedsReviewReason,
  knownMoney: Schema.OptionFromOptionalKey(Money),
  ...CapturedInterpretationContext.fields,
  sourceFormat: EmailSourceFormat,
  sourceChannel: Schema.Literal("forwarded-email"),
  sourceProvider: Schema.Literal("cloudflare-email"),
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
    reason: EmailRawSampleReviewReason,
    ingestSampleId: IngestSampleId,
    status: Schema.Literal("pending"),
  }),
  Schema.Struct({
    ...EmailNeedsReviewFields,
    reason: EmailNoSampleReviewReason,
    status: Schema.Literal("pending"),
  }),
  Schema.Struct({ ...EmailNeedsReviewFields, status: Schema.Literal("expired") }),
]).annotate({ identifier: "EmailNeedsReviewItem" });
export type EmailNeedsReviewItem = typeof EmailNeedsReviewItem.Type;

/** A receipt/screenshot whose acceptance is durable even while extraction is unavailable. No bytes, captions or provider routing are disclosed by this review projection. */
export const MediaNeedsReviewItem = Schema.Struct({
  id: NeedsReviewItemId,
  mediaSubmissionId: Schema.String.check(Schema.isUUID()).pipe(Schema.brand("MediaSubmissionId")),
  reason: Schema.Literals(["extraction-unavailable", "unparseable-material"]),
  ...CapturedInterpretationContext.fields,
  sourceChannel: Schema.Literal("whatsapp"),
  sourceFormat: Schema.Literal("image"),
  status: Schema.Literals(["pending", "expired"]),
  createdAt: UtcTimestamp,
}).annotate({ identifier: "MediaNeedsReviewItem" });
export type MediaNeedsReviewItem = typeof MediaNeedsReviewItem.Type;

/** Every visible Ingestion outcome requiring User review, independent of source channel. */
export const NeedsReviewItem = Schema.Union([
  StatementNeedsReviewItem,
  EmailNeedsReviewItem,
  MediaNeedsReviewItem,
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

const hoursPerDay = 24;
const minutesPerHour = 60;
const secondsPerMinute = 60;
const millisecondsPerSecond = 1000;
const maximumSweepRows = 200;
const maximumOutstandingSubmissions = 5;
const maximumSubmissionsPerHour = 20;

/**
 * How long unpublished staged statement bytes stay readable. Expiry is a hard bound, not a
 * retention preference: an expired staging row is neither publishable nor readable, and the
 * bounded sweep may delete its R2 object at any point after it.
 */
export const statementStagingLifetimeMilliseconds =
  hoursPerDay * minutesPerHour * secondsPerMinute * millisecondsPerSecond;

/**
 * How long one published submission may retain its staged material before extraction must have
 * consumed it. A queued submission past this bound becomes a visible `retention-expired` failure
 * and its bytes are reclaimed, so a submission that never runs cannot retain material forever.
 */
export const statementSubmissionRetentionMilliseconds = statementStagingLifetimeMilliseconds;

/** Largest number of expired staging rows one cleanup sweep will act on. */
export const maximumStatementStagingSweep = maximumSweepRows;

/** Largest number of a User's own submissions that may await or run extraction at once. */
export const maximumOutstandingStatementSubmissions = maximumOutstandingSubmissions;

/** Largest number of submissions one User may publish in a rolling hour. */
export const maximumStatementSubmissionsPerHour = maximumSubmissionsPerHour;

/** Stable revision of the statement interpretation pipeline recorded on every submission. */
export const statementParserRevision = InterpretationRevision.make("statement-parser-v1");

/**
 * Closed statement-material refusal vocabulary. Reasons are safe to map to canonical failures:
 * none contains statement contents, a filename, a digest, or platform detail. `cancelled` means the
 * caller's own request ended before the bytes were complete; `paywall` means the User's Free
 * statement backfill is already reserved or consumed; `unsupported-format` means the actual bytes
 * were not a tabular statement.
 */
export const StatementStagingFailureReason = Schema.Literals([
  "resource-limit",
  "unsupported-format",
  "malformed-file",
  "cancelled",
  "retention-expired",
  "not-found",
  "conflict",
  "paywall",
]);
export type StatementStagingFailureReason = typeof StatementStagingFailureReason.Type;
