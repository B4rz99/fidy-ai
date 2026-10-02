import type {
  PendingConsentExchangeId,
  Sha256Digest,
  WhatsAppProviderMessageId,
} from "@fidy/server/consent-contract";
import type { EmailAddress } from "@fidy/server/client";
import type { UserId } from "@fidy/server/identity-reference";
import type { WorkflowStepConfig } from "cloudflare:workers";
import { type Option, Schema } from "effect";

export type OnboardingEmailReplayInput = Readonly<{
  db: D1Database;
  exchangeId: PendingConsentExchangeId;
  submissionMessageId: WhatsAppProviderMessageId;
  submissionBodySha256: Sha256Digest;
}>;
export type OnboardingEmailEnrollmentInput = OnboardingEmailReplayInput &
  Readonly<{
    email: EmailAddress;
    createdAtMs: number;
    expiresAtMs: number;
  }>;
export type OnboardingEmailStatusInput = Readonly<{
  db: D1Database;
  exchangeId: PendingConsentExchangeId;
}>;
export type VerifiedEmailQueryInput = Readonly<{ userId: UserId }>;
export type EmailWorkOperation = "onboarding" | "browserPairing" | "emailReplacement";
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
export const OnboardingEmailWork = Schema.Struct({
  version: Schema.Literal(1),
  id: Schema.String.check(Schema.isUUID()),
});
export type OnboardingEmailWork = typeof OnboardingEmailWork.Type;
export const BrowserPairingEmailWork = Schema.Struct({
  kind: Schema.Literal("browser-pairing-email"),
  ...OnboardingEmailWork.fields,
});
export type BrowserPairingEmailWork = typeof BrowserPairingEmailWork.Type;
export const EmailReplacementWork = Schema.Struct({
  kind: Schema.Literal("email-replacement"),
  ...OnboardingEmailWork.fields,
});
export type EmailReplacementWork = typeof EmailReplacementWork.Type;
export type OnboardingEmailPublisher = { send: (work: OnboardingEmailWork) => Promise<unknown> };
export type BrowserPairingEmailPublisher = {
  send: (work: BrowserPairingEmailWork) => Promise<unknown>;
};
export type EmailReplacementPublisher = { send: (work: EmailReplacementWork) => Promise<unknown> };
export type OnboardingEmailStarter = {
  create: (options: { id: string; params: OnboardingEmailWork }) => Promise<unknown>;
  get: (id: string) => Promise<unknown>;
};
export type OnboardingEmailEnvironment = EmailDeliveryEnvironment &
  Readonly<{ ONBOARDING_EMAIL_QUEUE: Queue; ONBOARDING_EMAIL_WORKFLOW: Workflow }>;
export type BrowserPairingEmailEnvironment = EmailDeliveryEnvironment &
  Readonly<{ BROWSER_PAIRING_EMAIL_QUEUE: Queue; BROWSER_PAIRING_EMAIL_WORKFLOW: Workflow }>;
export type EmailReplacementEnvironment = EmailDeliveryEnvironment &
  Readonly<{ EMAIL_REPLACEMENT_QUEUE: Queue; EMAIL_REPLACEMENT_WORKFLOW: Workflow }>;
/** Select all due work or one already-committed identity, without changing the delivery policy. */
export type EmailPublication = Readonly<{ identity: Option.Option<string> }>;
