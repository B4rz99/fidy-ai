import type { UserId } from "../../src/core/identity/contract";
import type { WorkflowStepConfig } from "cloudflare:workers";
import { type Option, Schema } from "effect";

export type VerifiedEmailQueryInput = Readonly<{ userId: UserId }>;
export type EmailWorkOperation = "browserPairing" | "emailReplacement";
export type EmailPendingWorkObservationInput = Readonly<{
  db: D1Database;
  operation: EmailWorkOperation;
  limit: number;
}>;
export type EmailRejectedWorkObservationInput = EmailPendingWorkObservationInput &
  Readonly<{
    sinceMs: number;
  }>;

/** The native request boundary decodes proof-bearing input and never returns private evidence. */
export type EmailProofRequest = Readonly<{ request: Request; db: D1Database }>;
/** A commit callback offers only a durable identity; a missed offer is recovered by the schedule. */
export type EmailProofStart = EmailProofRequest & Readonly<{ onAccepted: (id: string) => void }>;
/** Provider binding used only while executing a private proof-delivery Activity. */
export type EmailDeliveryEnvironment = Readonly<{ DB: D1Database; RESEND_API_KEY: string }>;
/** A persisted Activity contains an identity and no mailbox, proof or provider result. */
export type EmailWorkflowInput = Readonly<{
  environment: EmailDeliveryEnvironment;
  payload: unknown;
  activity: (name: string, options: WorkflowStepConfig, run: () => Promise<void>) => Promise<void>;
}>;
/** The Queue stores bounded intent identities; its publication never establishes subject authority. */
export const EmailProofWork = Schema.Struct({
  version: Schema.Literal(1),
  id: Schema.String.check(Schema.isUUID()),
});
export type EmailProofWork = typeof EmailProofWork.Type;
export const BrowserPairingEmailWork = Schema.Struct({
  kind: Schema.Literal("browser-pairing-email"),
  ...EmailProofWork.fields,
});
export type BrowserPairingEmailWork = typeof BrowserPairingEmailWork.Type;
export const EmailReplacementWork = Schema.Struct({
  kind: Schema.Literal("email-replacement"),
  ...EmailProofWork.fields,
});
export type EmailReplacementWork = typeof EmailReplacementWork.Type;
export type BrowserPairingEmailPublisher = {
  send: (work: BrowserPairingEmailWork) => Promise<unknown>;
};
export type EmailReplacementPublisher = { send: (work: EmailReplacementWork) => Promise<unknown> };
export type BrowserPairingEmailEnvironment = EmailDeliveryEnvironment &
  Readonly<{ BROWSER_PAIRING_EMAIL_QUEUE: Queue; BROWSER_PAIRING_EMAIL_WORKFLOW: Workflow }>;
export type EmailReplacementEnvironment = EmailDeliveryEnvironment &
  Readonly<{ EMAIL_REPLACEMENT_QUEUE: Queue; EMAIL_REPLACEMENT_WORKFLOW: Workflow }>;
/** Select all due work or one already-committed identity, without changing the delivery policy. */
export type EmailPublication = Readonly<{ identity: Option.Option<string> }>;
