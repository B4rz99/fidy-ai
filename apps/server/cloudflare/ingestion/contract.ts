import type { UserStoreBindings } from "../directory/contract";
import {
  WhatsAppBusinessPhoneNumberId,
  type WhatsAppInboundEvent,
  WhatsAppMediaId,
} from "../../src/shell/channels/whatsapp/contract";
import type { ReviewCommand } from "../../src/core/ingestion/contract";
import type { UserId } from "../../src/core/identity/contract";

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

export type MediaAdmissionInput = Readonly<{
  db: D1Database;
  userId: UserId;
  event: WhatsAppInboundEvent;
}>;

export class StatementDocumentUnavailable extends Data.TaggedError("StatementDocumentUnavailable")<{
  reason: "invalid-material" | "media-unavailable" | "rate-limited" | "uncertain";
}> {}

export type ForwardedEmailMessage = Pick<
  ForwardableEmailMessage,
  "from" | "to" | "raw" | "rawSize" | "setReject"
>;

export type ForwardedEmailEnvironment = Readonly<{
  DB: D1Database;
  EMAIL_BUCKET: PrivateObjectBucket;
  EMAIL_QUEUE: Readonly<{
    send: (job: Readonly<{ receiptId: string; userId: string }>) => Promise<unknown>;
  }>;
}>;

export const StatementWork = Schema.Struct({
  traceContext: Schema.optionalKey(Schema.Unknown),
  version: Schema.Literal(1),
  userId: Schema.String.check(Schema.isUUID()),
  submissionId: StatementSubmissionId,
});

export const StatementCoordinatorActivity = Schema.Union([
  Schema.TaggedStruct("StatementWork", StatementWork.fields),
  Schema.TaggedStruct("StatementFailed", StatementWork.fields),
]);

export const ForwardedEmailWork = Schema.Struct({
  traceContext: Schema.optionalKey(Schema.Unknown),
  receiptId: Schema.String.check(Schema.isUUID()),
  userId: Schema.String.check(Schema.isUUID()),
});

export type StatementPublicationOutcome = Readonly<{
  readCommitted: (userId: string) => Effect.Effect<Option.Option<StatementSubmission>>;
  lostReplay: Effect.Effect<boolean>;
}>;

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

export const maximumSubmissionInputBytes = 4096;

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

export type StatementQueue = Readonly<{
  send: (work: typeof StatementWork.Type) => Promise<unknown>;
}>;

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

export const localDocumentUrl = "https://user.invalid/ingestion/document";
export const NativeStatementDocument = Schema.Struct({
  userId: Schema.String.check(Schema.isUUID()),
  portfolio: Schema.NonEmptyString,
  bsuid: Schema.NonEmptyString,
  message: Schema.NonEmptyString,
  endpoint: WhatsAppBusinessPhoneNumberId,
  mediaId: WhatsAppMediaId,
  occurredAt: Schema.Int,
  receivedAt: Schema.Int,
});
export const localMediaUrl = "https://user.invalid/ingestion/media";
export const NativeMedia = Schema.Struct({
  ...NativeStatementDocument.fields,
  caption: Schema.String,
});
export type LocalIngestionEnvironment = Readonly<{
  DIRECTORY: DurableObjectNamespace;
  STATEMENT_STAGING_BUCKET: R2Bucket;
  SAMPLE_BUCKET: R2Bucket;
  STATEMENT_EXTRACTION_QUEUE: Queue;
  EMAIL_BUCKET: R2Bucket;
  FORWARDED_EMAIL_QUEUE: Queue;
  KAPSO_API_KEY: string;
}>;

export const localEmailUrl = "https://user.invalid/ingestion/email";
export type NativeEmailEnvironment = UserStoreBindings;

export type LocalIngestionRequest = Readonly<{
  request: Request;
  env: LocalIngestionEnvironment;
  owns: (user: string) => boolean;
  storage: DurableObjectStorage;
}>;

export const localSampleReviewUrl = "https://user.invalid/ingestion/sample-review";
