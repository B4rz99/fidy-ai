import { InterpretationRevision } from "~/core/interpretation-evidence/contract";
import { Data, Schema } from "effect";
import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema, OpenApi } from "effect/http-api";
import {
  EmailForwardingAddress,
  EmailForwardingStatus,
  NeedsReviewItem,
  NeedsReviewItemId,
  NeedsReviewStatus,
  NotificationEmailInterpretationReviewReason,
  type ParsedStatementRow,
  ReviewCommand,
  ReviewDetail,
  ReviewEditResult,
  ReviewWorkspace,
  ReviewWorkspaceQuery,
  type StatementSourceFormat,
  StatementSubmission,
  StatementSubmissionId,
  SubmitForExtractionInput,
  maximumStatementBytes,
} from "~/core/ingestion/contract";

import {
  NotificationInterpretationEvidence,
  Transaction,
  TransactionExtraction,
} from "~/core/transactions/contract";
import {
  NotFound,
  OperationResponse,
  PaywallRequired,
  ValidationFailed,
  acceptedStatus,
} from "~/shell/public-http/contract";
import {
  operationPolicy,
  userOwnedAgentScoped,
  verifiedWhatsAppHostedOnly,
  webSessionOnly,
} from "~/shell/canonical-policy/contract";
/** Canonical Transaction facts supplied to resolve one pending statement row. */
export const ResolveNeedsReviewItemInput = Schema.Struct({
  extraction: TransactionExtraction,
}).annotate({ identifier: "ResolveNeedsReviewItemInput" });
export type ResolveNeedsReviewItemInput = typeof ResolveNeedsReviewItemInput.Type;

const read = operationPolicy({
  access: userOwnedAgentScoped("read"),
  requiredTier: "free",
  agentConfirmation: "not-required",
  kind: "query",
});
const write = operationPolicy({
  access: userOwnedAgentScoped("write"),
  requiredTier: "free",
  agentConfirmation: "not-required",
  kind: "mutation",
});
const statementUpload = operationPolicy({
  access: verifiedWhatsAppHostedOnly,
  requiredTier: "free",
  agentConfirmation: "not-required",
  kind: "mutation",
});
const confirmedWrite = operationPolicy({
  access: userOwnedAgentScoped("write"),
  requiredTier: "free",
  agentConfirmation: "required",
  kind: "mutation",
});

const maximumReviewMaterialCharacters = 100_000;
export const ReviewMaterial = Schema.Union([
  Schema.Struct({
    available: Schema.Literal(true),
    text: Schema.String.check(Schema.isMaxLength(maximumReviewMaterialCharacters)),
    truncated: Schema.Boolean,
  }),
  Schema.Struct({
    available: Schema.Literal(false),
    reason: Schema.Literals(["expired", "unavailable"]),
  }),
]);

export const IngestionGroup = HttpApiGroup.make("ingestion")
  .add(
    HttpApiEndpoint.get("getReviewMaterial", "/ingestion/review-workspace/:id/material", {
      params: Schema.Struct({ id: NeedsReviewItemId }),
      success: OperationResponse(ReviewMaterial),
      error: NotFound,
    })
      .annotate(
        OpenApi.Description,
        "Browser-only, no-store original evidence delivery while the original purpose remains unexpired. Escaped text only; media locators never promise retained bytes. Unavailable as an agent tool."
      )
      .annotateMerge(
        operationPolicy({
          access: webSessionOnly,
          requiredTier: "free",
          agentConfirmation: "not-required",
          kind: "query",
        })
      )
  )
  .add(
    HttpApiEndpoint.get("getReviewItem", "/ingestion/review-workspace/:id", {
      params: Schema.Struct({ id: NeedsReviewItemId }),
      success: OperationResponse(ReviewDetail),
      error: NotFound,
    })
      .annotate(
        OpenApi.Description,
        "Read one owned ingestion item and its revision-bound draft. Expired drafts are not disclosed; the original deadline never extends."
      )
      .annotateMerge(read)
  )
  .add(
    HttpApiEndpoint.post("applyReviewEdit", "/ingestion/review-workspace/edits", {
      payload: ReviewCommand,
      success: OperationResponse(ReviewEditResult),
      error: ValidationFailed,
    })
      .annotate(
        OpenApi.Description,
        "Autosave a draft, skip pending items, or restore skipped items using their observed revisions. Every item must remain unexpired. Bulk decisions are atomic; an uncertain outcome requires a reread."
      )
      .annotateMerge(confirmedWrite)
  )
  .add(
    HttpApiEndpoint.get("getReviewWorkspace", "/ingestion/review-workspace", {
      query: ReviewWorkspaceQuery,
      success: OperationResponse(ReviewWorkspace),
      error: ValidationFailed,
    })
      .annotate(
        OpenApi.Description,
        "Read the ingestion inbox ordered by original evidence expiry, or retained created, skipped and expired history. Returns a complete pending count, bounded metadata page and the first item’s revision-bound detail. Original material is excluded."
      )
      .annotateMerge(read)
  )
  .add(
    HttpApiEndpoint.post("enableEmailForwarding", "/ingestion/email-forwarding", {
      success: OperationResponse(EmailForwardingAddress),
    })
      .annotate(
        OpenApi.Description,
        "Idempotently enable one permanent unpredictable forwarding address for the caller. Later calls return the same address."
      )
      .annotateMerge(write)
  )
  .add(
    HttpApiEndpoint.get("getEmailForwarding", "/ingestion/email-forwarding", {
      success: OperationResponse(EmailForwardingStatus),
    })
      .annotate(
        OpenApi.Description,
        "Read the enabled address, remaining Free units in the current America/Bogota month, deferred email count, and exact reset instant. Trial and Pro report an uncapped remaining allowance."
      )
      .annotateMerge(read)
  )
  .add(
    HttpApiEndpoint.post("submitForExtraction", "/ingestion/statements", {
      payload: SubmitForExtractionInput,
      success: OperationResponse(StatementSubmission).pipe(HttpApiSchema.status(acceptedStatus)),
      error: [PaywallRequired, ValidationFailed],
    })
      .annotate(
        OpenApi.Description,
        "Publish one bounded CSV or XLSX directly attached in the verified WhatsApp conversation. The server stages bytes and binds upload provenance; browser and PAT callers cannot publish. Free includes one lifetime backfill consumed on capture; Trial and Pro permit ongoing submissions."
      )
      .annotateMerge(statementUpload)
  )
  .add(
    HttpApiEndpoint.get("getStatementSubmission", "/ingestion/statements/:id", {
      params: Schema.Struct({ id: StatementSubmissionId }),
      success: OperationResponse(StatementSubmission),
      error: NotFound,
    })
      .annotate(
        OpenApi.Description,
        "Read one owned statement submission and its complete accepted/review row accounting."
      )
      .annotateMerge(read)
  )
  .add(
    HttpApiEndpoint.get("listNeedsReviewItems", "/ingestion/needs-review", {
      query: Schema.Struct({
        status: Schema.OptionFromOptionalKey(NeedsReviewStatus),
        offset: Schema.OptionFromOptionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
        limit: Schema.OptionFromOptionalKey(
          Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 100 }))
        ),
      }),
      success: OperationResponse(Schema.Array(NeedsReviewItem)),
    })
      .annotate(
        OpenApi.Description,
        "List up to 100 of the caller's visible statement rows and forwarded emails requiring review, followed by retained resolution metadata. Use offset and limit to page, and status to filter. For one clarification question, request status=pending and limit=1. Pending statement items include parser-bounded original row evidence and email items reference their expiring IngestSample."
      )
      .annotateMerge(read)
  )
  .add(
    HttpApiEndpoint.post("resolveNeedsReviewItem", "/ingestion/needs-review/:id/resolve", {
      params: Schema.Struct({ id: NeedsReviewItemId }),
      payload: ResolveNeedsReviewItemInput,
      success: OperationResponse(Transaction),
      error: [NotFound, ValidationFailed],
    })
      .annotate(
        OpenApi.Description,
        "Resolve one pending statement row using its captured ServiceMarket, locale, and time zone. Atomically create the Transaction and immutable statement-line SourceAttestation, then erase original row evidence."
      )
      .annotateMerge(confirmedWrite)
  )
  .add(
    HttpApiEndpoint.post("skipNeedsReviewItem", "/ingestion/needs-review/:id/skip", {
      params: Schema.Struct({ id: NeedsReviewItemId }),
      success: OperationResponse(StatementSubmission),
      error: NotFound,
    })
      .annotate(
        OpenApi.Description,
        "Explicitly skip one pending statement row, erase its evidence, and complete clarification when no rows remain."
      )
      .annotateMerge(confirmedWrite)
  )
  .add(
    HttpApiEndpoint.post("abandonStatementSubmission", "/ingestion/statements/:id/abandon", {
      params: Schema.Struct({ id: StatementSubmissionId }),
      success: OperationResponse(StatementSubmission),
      error: NotFound,
    })
      .annotate(
        OpenApi.Description,
        "Permanently abandon pending statement clarification while preserving captured Transactions."
      )
      .annotateMerge(confirmedWrite)
  );

/** Non-canonical byte staging path; returned references confer no extraction eligibility. */
export const statementStagingPath = "/ingestion/statements/bytes";

export {
  maximumStatementBytes,
  StatementContentDigest,
  StatementFailureReason,
  StatementIdempotencyKey,
  StatementStagingId,
  StagedStatementBytes,
  StagedStatementReference,
  SubmitForExtractionInput,
  StatementSubmission,
  StatementStagingFailureReason,
  statementStagingLifetimeMilliseconds,
  statementSubmissionRetentionMilliseconds,
  maximumStatementStagingSweep,
  maximumOutstandingStatementSubmissions,
  maximumStatementSubmissionsPerHour,
  statementParserRevision,
} from "~/core/ingestion/contract";
export { StatementSubmissionId, StatementSourceFormat } from "~/core/ingestion/contract";

/** Safe terminal parser failure that never exposes uploaded statement contents. */
export class StatementParseFailed extends Data.TaggedError("StatementParseFailed")<{
  readonly safeReason: "unsupported-format" | "resource-limit" | "malformed-file";
}> {}

/** Bounded rows needed by native finalization; mapping samples remain owner-private. */
export type ParsedStatement = Readonly<{
  sourceFormat: StatementSourceFormat;
  headers: readonly [string, ...ReadonlyArray<string>];
  rows: ReadonlyArray<ParsedStatementRow>;
}>;

const bytesPerKibibyte = 1024;
const maximumExpandedMebibytes = 12;
const maximumReferencedTextMebibytes = 8;

/** Document admission ceilings; referenced bytes are a work charge, not an allocation estimate. */
export const statementParserLimits = {
  maximumDecodedBytes: maximumStatementBytes,
  maximumExpandedBytes: maximumExpandedMebibytes * bytesPerKibibyte * bytesPerKibibyte,
  maximumRows: 20_000,
  maximumXlsxCells: 100_000,
  maximumReferencedTextBytes: maximumReferencedTextMebibytes * bytesPerKibibyte * bytesPerKibibyte,
} as const;

/** Closed review outcomes; none contains hostile email or parser text. */
export const EmailInterpretationReviewReason = NotificationEmailInterpretationReviewReason;
export type EmailInterpretationReviewReason = NotificationEmailInterpretationReviewReason;

/** Immutable source-specific facts explaining one accepted deterministic interpretation. */
export const NotificationEmailInterpretationEvidence = Schema.Struct({
  ...NotificationInterpretationEvidence.fields,
  revision: InterpretationRevision,
});
export type NotificationEmailInterpretationEvidence =
  typeof NotificationEmailInterpretationEvidence.Type;

/** One accepted canonical extraction or a fail-closed review decision. */
export type NotificationEmailInterpretation =
  | Readonly<{
      _tag: "Interpreted";
      extraction: TransactionExtraction;
      evidence: NotificationEmailInterpretationEvidence;
    }>
  | Readonly<{
      _tag: "NeedsReview";
      reason: EmailInterpretationReviewReason;
    }>;

/** Finalization decision after retained-material validation; raw content never leaves the owner. */
export type NotificationEmailOutcome =
  | NotificationEmailInterpretation
  | Readonly<{
      _tag: "NeedsReview";
      reason: "canonical-validation-failed";
    }>;

/** Closed tooling refusal, independent of private catalog paths and definitions. */
export class EmailCatalogGenerationFailed extends Data.TaggedError("EmailCatalogGenerationFailed")<{
  readonly reason: "missing-formats" | "missing-fixture" | "stale-catalog";
}> {}
