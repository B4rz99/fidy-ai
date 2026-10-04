import type { UserId } from "../../src/core/identity/contract";
import type { WhatsAppInboundEvent } from "../../src/shell/channels/whatsapp/contract";
import { type Effect, type Option, Schema } from "effect";
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

/** Only a Cloudflare Email Routing event may supply this envelope; no HTTP path accepts it. */
export type ForwardedEmailMessage = Pick<
  ForwardableEmailMessage,
  "from" | "to" | "raw" | "rawSize" | "setReject"
>;
/** Private Email Worker bindings, never accessible through ingress. */
export type ForwardedEmailEnvironment = Readonly<{
  DB: D1Database;
  EMAIL_BUCKET: Readonly<{
    put: (
      key: string,
      bytes: Uint8Array,
      options: { customMetadata: { purpose: string } }
    ) => Promise<unknown>;
    delete: (key: string) => Promise<unknown>;
  }>;
  EMAIL_QUEUE: Readonly<{
    send: (job: Readonly<{ receiptId: string; userId: string }>) => Promise<unknown>;
  }>;
}>;

/** Secret-free, versioned identity shared by Queue, Workflow, and the User coordinator. */
export const StatementWork = Schema.Struct({
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

/** Maximum encoded input bytes accepted by one canonical statement submission. */
export const maximumSubmissionInputBytes = 4096;
