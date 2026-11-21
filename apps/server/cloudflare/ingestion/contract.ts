import type { UserStoreBindings } from "../directory/contract";
import {
  WhatsAppBusinessPhoneNumberId,
  WhatsAppMediaId,
} from "../../src/shell/channels/whatsapp/contract";

import { Data, Schema } from "effect";
import { StatementSubmissionId } from "../../src/shell/ingestion/contract";

export type ForwardedEmailMessage = Pick<
  ForwardableEmailMessage,
  "from" | "to" | "raw" | "rawSize" | "setReject"
>;

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

export const maximumSubmissionInputBytes = 4096;

export class ReviewUnavailable extends Data.TaggedError("ReviewUnavailable") {}

export const statementWorkflowRetention = {
  successRetention: "3 days",
  errorRetention: "3 days",
} as const;

export type StatementWorkflow = Readonly<{
  create: (options: {
    id: string;
    params: typeof StatementWork.Type;
    retention: typeof statementWorkflowRetention;
  }) => Promise<WorkflowInstance | void>;
  get: (id: string) => Promise<WorkflowInstance>;
}>;

export class StatementDeliveryUnavailable extends Data.TaggedError("StatementDeliveryUnavailable")<{
  readonly cause: unknown;
}> {}

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
