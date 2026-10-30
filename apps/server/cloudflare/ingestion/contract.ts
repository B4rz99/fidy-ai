import type { ReviewCommand } from "../../src/core/ingestion/contract";
import type { UserId } from "../../src/core/identity/contract";
import type { WhatsAppInboundEvent } from "../../src/shell/channels/whatsapp/contract";
import { Data, type Effect, type Option, Schema } from "effect";
import type { OwnedStatement } from "../../src/shell/owner-write/contract";
import type {
  QueryCaller,
  TransactionAuthority,
  TransactionCaller,
} from "../canonical-work/contract";
import type { CanonicalCapability } from "../../src/core/canonical-operations/contract";
import type { PrivateObjectBucket } from "../private-objects/contract";
import {
  type StatementSubmission,
  StatementSubmissionId,
} from "../../src/shell/ingestion/contract";

/** Already authenticated channel evidence; User and current association/Consent are rechecked in publication, never inferred from a provider id or caption. */
export type MediaAdmissionInput = Readonly<{
  db: D1Database;
  userId: UserId;
  event: WhatsAppInboundEvent;
}>;

/** Retrieval and staging failures disclose neither provider material nor storage details. */
export class StatementDocumentUnavailable extends Data.TaggedError("StatementDocumentUnavailable")<{
  reason: "invalid-material" | "media-unavailable" | "rate-limited" | "uncertain";
}> {}

/** Only a Cloudflare Email Routing event may supply this envelope; no HTTP path accepts it. */
export type ForwardedEmailMessage = Pick<
  ForwardableEmailMessage,
  "from" | "to" | "raw" | "rawSize" | "setReject"
>;
/** Private Email Worker bindings, never accessible through ingress. */
export type ForwardedEmailEnvironment = Readonly<{
  DB: D1Database;
  EMAIL_BUCKET: PrivateObjectBucket;
  EMAIL_QUEUE: Readonly<{
    send: (job: Readonly<{ receiptId: string; userId: string }>) => Promise<unknown>;
  }>;
}>;

/** Secret-free, versioned identity shared by Queue, Workflow, and the User coordinator. */
export const StatementWork = Schema.Struct({
  traceContext: Schema.optionalKey(Schema.Unknown),
  version: Schema.Literal(1),
  userId: Schema.String.check(Schema.isUUID()),
  submissionId: StatementSubmissionId,
});

/** Only the private Worker binding may send this coordinator activity. */
export const StatementCoordinatorActivity = Schema.Union([
  Schema.TaggedStruct("StatementWork", StatementWork.fields),
  Schema.TaggedStruct("StatementFailed", StatementWork.fields),
]);

/** Versioned, secret-free identity from the private forwarded-email Queue. */
export const ForwardedEmailWork = Schema.Struct({
  traceContext: Schema.optionalKey(Schema.Unknown),
  receiptId: Schema.String.check(Schema.isUUID()),
  userId: Schema.String.check(Schema.isUUID()),
});

/** A prepared statement exposes only committed public state and exact-race retry evidence.
 * Its captured admission and storage facts never leave Ingestion. Neither observation authorizes work.
 */
export type StatementPublicationOutcome = Readonly<{
  readCommitted: (userId: string) => Effect.Effect<Option.Option<StatementSubmission>>;
  lostReplay: Effect.Effect<boolean>;
}>;

/** Held live authority shared by canonical credential and admitted hosted statement adapters. */
export type StatementDecisionWork = Readonly<{
  db: D1Database;
  userId: string;
  authority: TransactionAuthority;
  originSessionId: Option.Option<string>;
  originTurns: Option.Option<OwnedStatement>;
  publicationOrigin: Option.Option<OwnedStatement>;
  requiredScope: Option.Option<CanonicalCapability>;
  current: number;
  bucket: Option.Option<R2Bucket>;
  input: unknown;
}>;

/** Maximum encoded input bytes accepted by one canonical statement submission. */
export const maximumSubmissionInputBytes = 4096;

/** Closed infrastructure failure; durable processing may retry without exposing storage details. */
export class StatementProcessingUnavailable extends Data.TaggedError(
  "StatementProcessingUnavailable"
) {}

export class ReviewUnavailable extends Data.TaggedError("ReviewUnavailable") {}
export type ReviewQueryWork = Readonly<{
  db: D1Database;
  subject: QueryCaller;
  request: Request;
  bucket: Option.Option<R2Bucket>;
}>;
export type ReviewEditWork = Readonly<{
  work: Readonly<{
    db: D1Database;
    subject: TransactionCaller;
    current: number;
    bucket: Option.Option<R2Bucket>;
  }>;
  command: ReviewCommand;
}>;
export type ReviewAuditWork = Readonly<{ db: D1Database; subject: QueryCaller; current: number }>;
export type ReviewRetentionWork = Readonly<{ db: D1Database; current: number }>;

export const statementWorkflowRetention = {
  successRetention: "3 days",
  errorRetention: "3 days",
} as const;

/** Publish only versioned User/submission identity. A resolved send means the Queue accepted an
 * offer, not that extraction completed; a rejected send may still have been accepted, so the
 * outbox retries the same idempotent identity after its cooldown. No bytes or passwords enter it.
 */
export type StatementQueue = Readonly<{
  send: (work: typeof StatementWork.Type) => Promise<unknown>;
}>;
/** Create one Workflow instance keyed by submission id. A resolved create means the instance
 * exists, not that it finished. If creation rejects ambiguously, get must resolve an existing
 * instance before Queue acknowledgement; a missing/unavailable get must reject for redelivery.
 * get may return an errored instance: the scheduled reconciler inspects status and settles it
 * under the User coordinator. The three-day retention applies to Workflow state only.
 */
export type StatementWorkflow = Readonly<{
  create: (options: {
    id: string;
    params: typeof StatementWork.Type;
    retention: typeof statementWorkflowRetention;
  }) => Promise<unknown>;
  get: (id: string) => Promise<unknown>;
}>;

export class StatementDeliveryUnavailable extends Data.TaggedError("StatementDeliveryUnavailable")<{
  readonly cause: unknown;
}> {}
export type StatementDispatchBindings = Readonly<{
  DB: D1Database;
  STATEMENT_EXTRACTION_QUEUE: StatementQueue;
  STATEMENT_EXTRACTION_WORKFLOW: Option.Option<StatementWorkflow>;
}>;
