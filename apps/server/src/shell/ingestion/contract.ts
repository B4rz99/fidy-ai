import { InterpretationRevision } from "~/core/interpretation-evidence/contract";
import { Data, Schema } from "effect";
import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema, OpenApi } from "effect/unstable/httpapi";
import {
  EmailForwardingAddress,
  EmailForwardingStatus,
  NeedsReviewItem,
  NotificationEmailInterpretationReviewReason,
  type ParsedStatementRow,
  StatementSubmission,
  SubmitForExtractionInput,
  maximumStatementBytes,
} from "~/core/ingestion/contract";
import {
  NeedsReviewItemId,
  type StatementSourceFormat,
  StatementSubmissionId,
} from "~/core/ingestion/reference";
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
import { operationPolicy, patScoped } from "~/shell/canonical-policy/contract";
/** Canonical Transaction facts supplied to resolve one pending statement row. */
export const ResolveNeedsReviewItemInput = Schema.Struct({
  extraction: TransactionExtraction,
}).annotate({ identifier: "ResolveNeedsReviewItemInput" });
export type ResolveNeedsReviewItemInput = typeof ResolveNeedsReviewItemInput.Type;

const read = operationPolicy({
  access: patScoped("read"),
  requiredTier: "free",
  agentConfirmation: "not-required",
  kind: "query",
});
const write = operationPolicy({
  access: patScoped("write"),
  requiredTier: "free",
  agentConfirmation: "not-required",
  kind: "mutation",
});
const confirmedWrite = operationPolicy({
  access: patScoped("write"),
  requiredTier: "free",
  agentConfirmation: "required",
  kind: "mutation",
});

/** Canonical durable statement, forwarded-email, and visible review capabilities. */
export const IngestionGroup = HttpApiGroup.make("ingestion")
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
        "Idempotently queue one bounded CSV or XLSX statement whose bytes were first staged through the authenticated statement staging transport. Free includes one lifetime backfill; Pro access permits ongoing submissions. Poll the returned submission and inspect NeedsReviewItems after completion."
      )
      .annotateMerge(write)
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
        offset: Schema.OptionFromOptionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
        limit: Schema.OptionFromOptionalKey(
          Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 100 }))
        ),
      }),
      success: OperationResponse(Schema.Array(NeedsReviewItem)),
    })
      .annotate(
        OpenApi.Description,
        "List up to 100 of the caller's visible statement rows and forwarded emails requiring review, followed by retained resolution metadata. Use offset and limit to page; pending statement items include parser-bounded original row evidence and email items reference their expiring IngestSample."
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
  );

/**
 * Path of the Core Worker statement byte staging transport. It is named here rather than in the
 * canonical API because it is deliberately not a canonical operation (#788, ADR 0028): the ingress
 * and edge policy import it, agents and MCP tools never see it, and every response it returns is a
 * non-authoritative staged reference that grants no extraction eligibility.
 */
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
export { StatementSubmissionId, StatementSourceFormat } from "~/core/ingestion/reference";

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
const maximumExpandedMebibytes = 25;

/** Compressed-input and expanded-content ceilings enforced before native finalization. */
export const statementParserLimits = {
  maximumDecodedBytes: maximumStatementBytes,
  maximumExpandedBytes: maximumExpandedMebibytes * bytesPerKibibyte * bytesPerKibibyte,
  maximumRows: 20_000,
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
