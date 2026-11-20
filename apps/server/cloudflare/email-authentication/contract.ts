import { EmailAddress } from "../../src/core/email-authentication/contract";
import { UserId } from "../../src/core/identity/contract";
import type { WorkflowStepConfig } from "cloudflare:workers";
import { type Option, Schema } from "effect";

export const loginAllowanceUrl = "https://directory.invalid/login-email/allowance";
export const LoginMailboxCandidate = Schema.Struct({
  user_id: UserId,
  address: EmailAddress,
  revision: Schema.Int,
});
export const loginCheckUrl = "https://user.invalid/login-email/check";
export const loginStartUrl = "https://user.invalid/login-email/start";
export const loginVerifyUrl = "https://user.invalid/login-email/verify";
export const loginDeliverUrl = "https://user.invalid/login-email/deliver";
export const LoginEmailHandoff = Schema.Struct({
  id: Schema.String,
  pairing_id: Schema.String,
  user_id: UserId,
  ordinal: Schema.Int,
  verifier_digest: Schema.String,
  expires_at_ms: Schema.Int,
  wrong_attempts: Schema.Int,
  last_poll_ms: Schema.NullOr(Schema.Int),
  minimum_poll_seconds: Schema.Int,
});
export const NativeLoginEmailWork = Schema.Struct({
  traceContext: Schema.optionalKey(Schema.Unknown),
  kind: Schema.Literal("browser-pairing-email"),
  version: Schema.Literal(2),
  id: Schema.String.check(Schema.isUUID()),
  userId: UserId,
});
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

export type EmailProofRequest = Readonly<{ request: Request; db: D1Database }>;

export type EmailProofStart = EmailProofRequest & Readonly<{ onAccepted: (id: string) => void }>;

export type EmailDeliveryEnvironment = Readonly<{ DB: D1Database; RESEND_API_KEY: string }>;

export type EmailWorkflowInput = Readonly<{
  environment: EmailDeliveryEnvironment;
  payload: unknown;
  activity: (name: string, options: WorkflowStepConfig, run: () => Promise<void>) => Promise<void>;
}>;

export const EmailProofWork = Schema.Struct({
  traceContext: Schema.optionalKey(Schema.Unknown),
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

export type EmailPublication = Readonly<{ identity: Option.Option<string> }>;
