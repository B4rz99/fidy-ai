import { CategoryId } from "~/core/categories/contract";
import { freeAllowanceLimits } from "~/core/quotas/contract";
import { Option, Schema, Struct } from "effect";
import {
  CapturedInterpretationContext,
  InterpretationRevision,
} from "~/core/interpretation-evidence/contract";
import { Money } from "~/core/_shared/money";
import { ProviderMessageEvidence } from "~/core/provider-evidence/contract";
import { UtcTimestamp } from "~/core/_shared/time";
import { Direction, TransactionExtraction, TransactionId } from "~/core/transactions/contract";

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

export const CaptureInterpretationEvidence = Schema.Struct({
  currencyBasis: Schema.Literals(["explicit", "default"]),
  dateBasis: Schema.Literals(["explicit", "submission-date-default"]),
  revision: InterpretationRevision,
}).annotate({ identifier: "CaptureInterpretationEvidence" });

export type CaptureInterpretationEvidence = typeof CaptureInterpretationEvidence.Type;

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

export type CaptureInterpretationInput = Readonly<{
  proposal: CaptureProposal;
  context: CapturedInterpretationContext;
  submittedAt: UtcTimestamp;
  now: UtcTimestamp;
}>;

export const captureInterpretationRevision = InterpretationRevision.make("capture-v1");

export const maximumEmailEvidenceIdCharacters = 256;

export const maximumForwardedEmailDeliveryIdCharacters = 128;

export const StatementSourceFormat = Schema.Literals(["csv", "xlsx"]);

export type StatementSourceFormat = typeof StatementSourceFormat.Type;

export const EmailSourceFormat = Schema.Literal("notification-email");

export type EmailSourceFormat = typeof EmailSourceFormat.Type;

export const StatementSubmissionId = Schema.String.check(Schema.isUUID())
  .pipe(Schema.brand("StatementSubmissionId"))
  .annotate({ identifier: "StatementSubmissionId" });

export type StatementSubmissionId = typeof StatementSubmissionId.Type;

export const NeedsReviewItemId = Schema.String.check(Schema.isUUID())
  .pipe(Schema.brand("NeedsReviewItemId"))
  .annotate({ identifier: "NeedsReviewItemId" });

export type NeedsReviewItemId = typeof NeedsReviewItemId.Type;

export const EmailForwardingLocalPart = Schema.String.check(
  Schema.isPattern(/^[a-z0-9_-]{24,64}$/u)
)
  .pipe(Schema.brand("EmailForwardingLocalPart"))
  .annotate({ identifier: "EmailForwardingLocalPart" });

export type EmailForwardingLocalPart = typeof EmailForwardingLocalPart.Type;

export const EmailForwardingAddressId = Schema.String.check(Schema.isUUID())
  .pipe(Schema.brand("EmailForwardingAddressId"))
  .annotate({ identifier: "EmailForwardingAddressId" });

export type EmailForwardingAddressId = typeof EmailForwardingAddressId.Type;

export const IngestSampleId = Schema.String.check(Schema.isUUID())
  .pipe(Schema.brand("IngestSampleId"))
  .annotate({ identifier: "IngestSampleId" });

export type IngestSampleId = typeof IngestSampleId.Type;

export const ReceivedEmailId = Schema.NonEmptyString.check(
  Schema.isTrimmed(),
  Schema.isMaxLength(maximumEmailEvidenceIdCharacters)
).pipe(Schema.brand("ReceivedEmailId"));

export type ReceivedEmailId = typeof ReceivedEmailId.Type;

export const ForwardedEmailDeliveryId = Schema.NonEmptyString.check(
  Schema.isTrimmed(),
  Schema.isMaxLength(maximumForwardedEmailDeliveryIdCharacters)
).pipe(Schema.brand("ForwardedEmailDeliveryId"));

export type ForwardedEmailDeliveryId = typeof ForwardedEmailDeliveryId.Type;

export const freeMediaSubmissionCap = freeAllowanceLimits.media_submission;

export const freeForwardedEmailCap = freeAllowanceLimits.forwarded_email;

export const freeForwardedEmailDeferredCap = 50;

export const forwardedEmailOutstandingCap = 100;

export const forwardedEmailRetrievalDeadline = "3 minutes";

export const maximumEmailAddressCharacters = 320;

export const maximumEmailRecipients = 20;

export const maximumEmailSubjectCharacters = 998;

export const maximumEmailTextCharacters = 262_144;

export const maximumEmailHtmlCharacters = 524_288;

export const maximumEmailInlineImages = 8;

export const maximumEmailInlineImageBytes = 1_048_576;

export const maximumEmailInlineImageDimension = 4_096;

const maximumStatementMebibytes = 5;

const bytesPerKibibyte = 1024;

const bytesPerMebibyte = bytesPerKibibyte * bytesPerKibibyte;

export const maximumStatementBytes = maximumStatementMebibytes * bytesPerMebibyte;

export const EmailForwardingAddress = Schema.Struct({
  id: EmailForwardingAddressId,
  address: Schema.NonEmptyString.check(
    Schema.isTrimmed(),
    Schema.isMaxLength(maximumEmailAddressCharacters)
  ),
  createdAt: UtcTimestamp,
}).annotate({ identifier: "EmailForwardingAddress" });

export type EmailForwardingAddress = typeof EmailForwardingAddress.Type;

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

export const StatementStagingId = Schema.String.check(Schema.isUUID())
  .pipe(Schema.brand("StatementStagingId"))
  .annotate({ identifier: "StatementStagingId" });

export type StatementStagingId = typeof StatementStagingId.Type;

export const StatementContentDigest = Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/u))
  .pipe(Schema.brand("StatementContentDigest"))
  .annotate({ identifier: "StatementContentDigest" });

export type StatementContentDigest = typeof StatementContentDigest.Type;

export const StagedStatementBytes = Schema.Struct({
  stagingId: StatementStagingId,
  byteLength: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: maximumStatementBytes })),
  sha256: StatementContentDigest,
  sourceFormat: StatementSourceFormat,
  expiresAt: UtcTimestamp,
}).annotate({ identifier: "StagedStatementBytes" });

export type StagedStatementBytes = typeof StagedStatementBytes.Type;

export const StagedStatementReference = Schema.Struct({
  stagingId: StatementStagingId,
  byteLength: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: maximumStatementBytes })),
  sha256: StatementContentDigest,
}).annotate({ identifier: "StagedStatementReference" });

export type StagedStatementReference = typeof StagedStatementReference.Type;

export const StatementIdempotencyKey = Schema.String.check(Schema.isUUID()).pipe(
  Schema.brand("StatementIdempotencyKey")
);

export type StatementIdempotencyKey = typeof StatementIdempotencyKey.Type;

export const SubmitForExtractionInput = Schema.Struct({
  idempotencyKey: StatementIdempotencyKey,
  reference: StagedStatementReference,
}).annotate({ identifier: "SubmitForExtractionInput" });

export type SubmitForExtractionInput = typeof SubmitForExtractionInput.Type;

const StatementAccountingFields = Schema.Struct({
  inputRows: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  acceptedRows: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  needsReviewRows: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  skippedRows: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
  abandonedRows: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
});

const conservedStatementRows = Schema.makeFilter<typeof StatementAccountingFields.Type>((counts) =>
  counts.inputRows ===
  counts.acceptedRows +
    counts.needsReviewRows +
    (counts.skippedRows ?? 0) +
    (counts.abandonedRows ?? 0)
    ? undefined
    : { path: ["inputRows"], issue: "Expected acceptedRows plus needsReviewRows" }
);

export const StatementAccounting = StatementAccountingFields.check(conservedStatementRows).annotate(
  { identifier: "StatementAccounting" }
);

export type StatementAccounting = typeof StatementAccounting.Type;

export const StatementSubmissionStatus = Schema.Literals([
  "queued",
  "processing",
  "awaiting-clarification",
  "completed",
  "abandoned",
  "failed",
]);

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

export const StatementSubmission = Schema.Union([
  Schema.Struct({ ...StatementSubmissionBase.fields, status: Schema.Literal("queued") }),
  Schema.Struct({
    ...StatementSubmissionBase.fields,
    status: Schema.Literal("processing"),
    startedAt: UtcTimestamp,
  }),
  Schema.Struct({
    ...StatementSubmissionBase.fields,
    status: Schema.Literal("awaiting-clarification"),
    startedAt: UtcTimestamp,
    accounting: StatementAccounting,
  }),
  Schema.Struct({
    ...StatementSubmissionBase.fields,
    status: Schema.Literal("abandoned"),
    startedAt: UtcTimestamp,
    completedAt: UtcTimestamp,
    accounting: StatementAccounting,
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

export const CsvRowEvidence = Schema.Struct({
  sourceFormat: Schema.Literal("csv"),
  recordNumber: Schema.Int.check(Schema.isGreaterThan(0)),
  startLine: Schema.Int.check(Schema.isGreaterThan(0)),
  endLine: Schema.Int.check(Schema.isGreaterThan(0)),
  rawRecord: Schema.String,
  fields: Schema.Array(Schema.String),
});

export const XlsxCellEvidence = Schema.Struct({
  address: Schema.NonEmptyString,
  cellType: Schema.Literals(["blank", "string", "number", "date", "boolean", "error"]),
  value: Schema.String,
  formattedText: Schema.OptionFromOptionalKey(Schema.String),
  numberFormat: Schema.OptionFromOptionalKey(Schema.String),
  formula: Schema.OptionFromOptionalKey(Schema.String),
});

export type XlsxCellEvidence = typeof XlsxCellEvidence.Type;

export const XlsxRowEvidence = Schema.Struct({
  sourceFormat: Schema.Literal("xlsx"),
  sheetName: Schema.NonEmptyString,
  sheetIndex: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  rowNumber: Schema.Int.check(Schema.isGreaterThan(0)),
  hidden: Schema.Boolean,
  cells: Schema.Array(XlsxCellEvidence),
});

export const StatementRowEvidence = Schema.Union([CsvRowEvidence, XlsxRowEvidence]);

export type StatementRowEvidence = typeof StatementRowEvidence.Type;

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

export const NotificationEmailInterpretationReviewReason = Schema.Literals([
  "unsupported-content",
  "unknown-format",
  "ambiguous-format",
  "invalid-format",
]);

export type NotificationEmailInterpretationReviewReason =
  typeof NotificationEmailInterpretationReviewReason.Type;

export const EmailRawSampleReviewReason = Schema.Union([
  Schema.Literal("canonical-validation-failed"),
  NotificationEmailInterpretationReviewReason,
]);

export type EmailRawSampleReviewReason = typeof EmailRawSampleReviewReason.Type;

export const EmailNoSampleReviewReason = Schema.Literals([
  "provider-retrieval-failed",
  "processing-interrupted",
  "consent-revoked",
]);

export type EmailNoSampleReviewReason = typeof EmailNoSampleReviewReason.Type;

export const EmailNeedsReviewReason = Schema.Union([
  EmailRawSampleReviewReason,
  EmailNoSampleReviewReason,
]);

export type EmailNeedsReviewReason = typeof EmailNeedsReviewReason.Type;

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

export const NeedsReviewStatus = Schema.Literals([
  "pending",
  "expired",
  "resolved",
  "skipped",
  "abandoned",
]);

const NeedsReviewItemVariants = Schema.Union([
  Schema.Struct({ ...NeedsReviewBase.fields, status: Schema.Literal("skipped") }),
  Schema.Struct({ ...NeedsReviewBase.fields, status: Schema.Literal("abandoned") }),
  Schema.Struct({
    ...NeedsReviewBase.fields,
    status: Schema.Literal("pending"),
    originalEvidence: Schema.OptionFromOptionalKey(StatementRowEvidence),
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
    item.status !== "pending" ||
    Option.isNone(item.originalEvidence) ||
    item.sourceFormat === item.originalEvidence.value.sourceFormat
      ? undefined
      : { path: ["sourceFormat"], issue: "Expected the original evidence format" }
);

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

export const ParsedStatementRow = ParsedStatementRowFields.check(matchingCsvRowEvidence);

export type ParsedStatementRow = typeof ParsedStatementRow.Type;

export type NeedsReviewStatementRow = Readonly<{
  outcome: "needs-review";
  recordNumber: number;
  reason: NeedsReviewReason;
  knownMoney: Option.Option<Money>;
  suggestions: Option.Option<ReviewDraft>;
  issues: ReadonlyArray<typeof CapturedFieldIssue.Type>;
  evidence: StatementRowEvidence;
}>;

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

const maximumOutstandingSubmissions = 5;

const maximumSubmissionsPerHour = 20;

export const statementStagingLifetimeMilliseconds =
  hoursPerDay * minutesPerHour * secondsPerMinute * millisecondsPerSecond;

export const statementSubmissionRetentionMilliseconds = statementStagingLifetimeMilliseconds;

export const maximumOutstandingStatementSubmissions = maximumOutstandingSubmissions;

export const maximumStatementSubmissionsPerHour = maximumSubmissionsPerHour;

export const statementParserRevision = InterpretationRevision.make("statement-parser-v1");

export const ReviewStatus = Schema.Literals(["pending", "created", "skipped", "expired"]);

const maximumReviewPreviewLength = 120;

const ReviewPreview = Schema.Struct({
  counterparty: Schema.String.check(Schema.isMaxLength(maximumReviewPreviewLength)),
  amount: Schema.String.check(Schema.isMaxLength(maximumReviewPreviewLength)),
  currency: Schema.OptionFromOptionalKey(Money.fields.currency),
});

export const ReviewMetadata = Schema.Struct({
  preview: Schema.OptionFromOptionalKey(ReviewPreview),
  revision: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  id: NeedsReviewItemId,
  source: Schema.Literals(["statement", "email", "media"]),
  timeZone: CapturedInterpretationContext.fields.timeZone,
  reason: Schema.String,
  createdAt: UtcTimestamp,
  expiresAt: UtcTimestamp,
});

export const ReviewSummary = Schema.Union([
  Schema.Struct({
    ...ReviewMetadata.fields,
    status: Schema.Literal("created"),
    transactionId: TransactionId,
  }),
  Schema.Struct({
    ...ReviewMetadata.fields,
    status: Schema.Literals(["pending", "skipped", "expired"]),
    transactionId: Schema.OptionFromOptionalKey(Schema.Never),
  }),
]);

export type ReviewSummary = typeof ReviewSummary.Type;

export const reviewPageSize = 50;

export const ReviewWorkspaceQuery = Schema.Struct({
  limit: Schema.optionalKey(
    Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: reviewPageSize })).annotate({
      description:
        "Maximum returned item rows, from 0 through 50, defaulting to 50. Zero returns complete counts and an empty item list.",
    })
  ),
  status: Schema.OptionFromOptionalKey(
    Schema.Literals(["pending", "created", "skipped", "expired", "history"])
  ),
  offset: Schema.OptionFromOptionalKey(
    Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 10_000 }))
  ),
});

const maximumReviewDraftFieldLength = 120;

const maximumReviewProvidedFields = 5;

export const ReviewField = Schema.Literals([
  "money",
  "direction",
  "counterparty",
  "occurredAt",
  "categoryId",
]);

export const ReviewDraft = Schema.Struct({
  amount: Schema.String.check(Schema.isMaxLength(maximumReviewDraftFieldLength)),
  currency: Schema.OptionFromOptionalKey(Money.fields.currency),
  direction: Schema.OptionFromOptionalKey(Direction),
  counterparty: Schema.String.check(Schema.isMaxLength(maximumReviewDraftFieldLength)),
  occurredAt: Schema.String.check(Schema.isMaxLength(maximumReviewDraftFieldLength)),
  categoryId: Schema.OptionFromOptionalKey(CategoryId),
  userProvidedFields: Schema.Array(ReviewField).check(
    Schema.isMaxLength(maximumReviewProvidedFields)
  ),
});

export type ReviewDraft = typeof ReviewDraft.Type;

export const ReviewReference = Schema.Struct({
  id: NeedsReviewItemId,
  revision: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
});

export type ReviewReference = typeof ReviewReference.Type;

export const ReviewDetail = Schema.Struct({
  item: ReviewSummary,
  revision: ReviewReference.fields.revision,
  draft: Schema.OptionFromOptionalKey(ReviewDraft),
  suggestions: Schema.OptionFromOptionalKey(ReviewDraft),
});

export type ReviewDetail = typeof ReviewDetail.Type;

export const ReviewWorkspace = Schema.Struct({
  pendingCount: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  total: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  items: Schema.Array(ReviewSummary),
  selectedDetail: Schema.OptionFromOptionalKey(ReviewDetail),
});

const ReviewReferences = Schema.NonEmptyArray(ReviewReference).check(Schema.isMaxLength(100));

export const ReviewCommand = Schema.Union([
  Schema.TaggedStruct("Create", {
    ...ReviewReference.fields,
    extraction: TransactionExtraction,
    categoryId: Schema.OptionFromOptionalKey(CategoryId),
  }),
  Schema.TaggedStruct("SaveDraft", { ...ReviewReference.fields, draft: ReviewDraft }),
  Schema.TaggedStruct("Skip", { items: ReviewReferences }),
  Schema.TaggedStruct("Restore", { items: ReviewReferences }),
]);

export type ReviewCommand = typeof ReviewCommand.Type;

export const ReviewEditResult = Schema.Array(ReviewDetail);

const maximumStructuralTagCount = 9999;

const count = Schema.Int.check(
  Schema.isBetween({ minimum: 0, maximum: maximumStructuralTagCount })
);

export const SampleArtifact = Schema.Struct({
  serviceMarket: Schema.Literal("CO"),
  sourceFormat: Schema.Literal("notification-email"),
  sourceProvider: Schema.Literal("cloudflare-email"),
  parserRevision: Schema.Literal("cloudflare-mime-v1"),
  anonymizationRevision: Schema.Literal("structural-tags-v1"),
  structure: Schema.Struct({
    table: count,
    tr: count,
    td: count,
    p: count,
    span: count,
    div: count,
  }),
});

const sampleRef = Schema.String.check(Schema.isUUID());

const sampleVersion = {
  candidateId: sampleRef,
  revision: Schema.Int.check(Schema.isGreaterThan(0)),
  digest: Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/u)),
};

export const SampleReviewCommand = Schema.Union([
  Schema.Struct({ action: Schema.Literal("preview"), userId: sampleRef }),
  Schema.Struct({
    action: Schema.Literals(["approve", "reject"]),
    userId: sampleRef,
    ...sampleVersion,
  }),
  Schema.Struct({ action: Schema.Literal("withdraw"), sampleId: sampleRef }),
]);

export const SampleReviewResult = Schema.Union([
  Schema.Struct({ status: Schema.Literal("preview"), ...sampleVersion, artifact: SampleArtifact }),
  Schema.Struct({ status: Schema.Literals(["approved", "published"]), sampleId: sampleRef }),
  Schema.Struct({ status: Schema.Literals(["rejected", "withdrawn", "empty"]) }),
]);

export const sampleReviewPath = "/internal/sample-review";
