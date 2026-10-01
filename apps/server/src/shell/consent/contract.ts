import { type Option, Schema } from "effect";
import { DisclosureSnapshot } from "~/core/consent/contract";
import type { OwnedStatement } from "~/shell/_shared/owned-statement";
import type { FreshSessionSubject } from "~/shell/identity/contract";

export {
  ConsentIngressExchange,
  type ConsentIngressMessage,
  DisclosureSnapshot,
  OnboardingConsentBasis,
  PATRevocationOrigin,
} from "~/core/consent/contract";
export {
  ConsentRecordId,
  DisclosureRevision,
  PendingConsentExchangeId,
  PolicyRevision,
  Sha256Digest,
} from "~/core/consent/reference";
export { DisclosureDeliveryCorrelationToken } from "~/shell/channels/whatsapp/disclosure-model";
export { WhatsAppProviderMessageId } from "~/core/provider-evidence/contract";
export { WhatsAppDeliveryKey } from "~/shell/channels/whatsapp/model";
export {
  WhatsAppBusinessPhoneNumberId,
  WhatsAppBusinessPortfolioId,
  WhatsAppBusinessScopedUserId,
} from "~/core/identity/reference";
export type { KapsoSendFailed, KapsoSentMessage } from "~/shell/channels/whatsapp/kapso-client";
export type { WhatsAppInboundEvent, WhatsAppWebhookReceipt } from "~/shell/channels/whatsapp/model";
export {
  maxKapsoFutureTimestampMinutes,
  maxKapsoWebhookBytes,
} from "~/shell/channels/whatsapp/kapso-webhook";

/** Persist and decode only a validated version of the exact disclosure shown to the caller. */
export const PendingDisclosureJson = Schema.fromJsonString(Schema.toCodecJson(DisclosureSnapshot));

/** Pre-User mailbox collection and provider-acceptance states safe to disclose to its WhatsApp caller. */
export type EmailStatus =
  | "awaiting_email"
  | "awaiting_delivery"
  | "sending"
  | "awaiting_proof"
  | "rejected"
  | "ambiguous";

/** Fresh authenticated User and one live PAT selected for symmetric Consent revocation. */
export type RevokeOnePATConsentInput = Readonly<{
  session: FreshSessionSubject;
  input: Readonly<{ id: string; shortId: string; current: number }>;
}>;

/** Fresh authenticated User whose active PAT or unclaimed pairing grants must be revoked. */
export type RevokeAllPATConsentsInput = Readonly<{
  session: FreshSessionSubject;
  current: number;
}>;

/** Bounded expiry selection; current is the decision instant in Unix milliseconds. */
export type ExpirePATConsentsInput = Readonly<{ current: number; limit: number }>;

/** The exact reviewed manual grant, identified by its issuance request and new evidence id. */
export type ManualPATConsentInput = Readonly<{
  session: FreshSessionSubject;
  input: Readonly<{ id: string; requestId: string; disclosure: string; current: number }>;
}>;

/** The exact reviewed pairing grant, identified by its pairing and new evidence id. */
export type PairedPATConsentInput = Readonly<{
  session: FreshSessionSubject;
  input: Readonly<{ id: string; pairingId: string; disclosure: string; current: number }>;
}>;

/** Reviewed subject correlations for owner-composed D1 work; callers cannot supply SQL identifiers. */
export type ConsentSubjectColumn =
  | "web_sessions.user_id"
  | "pats.user_id"
  | "pat_pairings.user_id"
  | "whatsapp_identities.user_id"
  | "users.id"
  | "u.id"
  | "r.user_id"
  | "o.user_id"
  | "a.user_id"
  | "w.user_id"
  | "s.user_id"
  | "transactions.user_id"
  | "forwarded_email_receipts.user_id";

/** One explicit User or a reviewed correlation to the same owner row being protected. */
export type ConsentSubject =
  | Readonly<{ _tag: "User"; userId: string }>
  | Readonly<{ _tag: "Owner"; column: ConsentSubjectColumn }>;

/** Onboarding evidence, absence of withdrawal, or both, as required by the protected purpose. */
export type ConsentStandingRequirement = "granted" | "unrevoked" | "active";

/** An owner action composed at its current WHERE condition, before any owner-owned ordering. */
export type ConsentProtectedStatement = Readonly<{
  statement: OwnedStatement;
  subject: ConsentSubject;
  requirement: ConsentStandingRequirement;
}>;

/** The closed credential owners that compose their live authority with Consent standing. */
export type ConsentAuthority = Readonly<{
  table: "pats" | "pat_pairings" | "web_sessions" | "whatsapp_identities";
  predicate: string;
  bindings: ReadonlyArray<string | number | Uint8Array>;
}>;

/** The exact evidence that must precede a PAT owner's terminal transition in the same D1 unit. */
export type PATRevocationProtection =
  | Readonly<{ _tag: "UserPAT"; sessionId: string; occurredAtMs: Option.Option<number> }>
  | Readonly<{ _tag: "UserPairing"; sessionId: string }>
  | Readonly<{ _tag: "ExpiredPAT" }>
  | Readonly<{ _tag: "ExpiredPairing" }>;
