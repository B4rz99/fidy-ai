import { type Option, Schema } from "effect";
import type { UserId } from "~/core/identity/contract";
import type { OAuthConnectionId } from "~/core/oauth-agents/contract";
import type { PATScopes } from "~/core/tokens/contract";
import { DisclosureSnapshot } from "~/core/consent/contract";
import { type OwnedStatement } from "~/shell/owner-write/contract";
import { type PATGrantSelection, type PairingGrantSelection } from "~/shell/tokens/contract";
import { type FreshSessionSubject } from "~/shell/web-session/contract";

/** Additional launch opt-in categories, each independent of the weekly summary grant. */
export const ProactivityOptInKind = Schema.Literals([
  "budget-threshold",
  "manual-entry-reminder",
  "new-recurring-series",
]);
export type ProactivityOptInKind = typeof ProactivityOptInKind.Type;

export {
  ConsentIngressExchange,
  DisclosureSnapshot,
  OnboardingConsentBasis,
  PATRevocationOrigin,
  type ConsentIngressMessage,
} from "~/core/consent/contract";
export {
  ConsentRecordId,
  DisclosureRevision,
  PendingConsentExchangeId,
  PolicyRevision,
  Sha256Digest,
} from "~/core/consent/contract";
export {
  WhatsAppBusinessPhoneNumberId,
  WhatsAppBusinessPortfolioId,
  WhatsAppBusinessScopedUserId,
} from "~/core/identity/contract";
export { WhatsAppProviderMessageId } from "~/core/provider-evidence/contract";
export {
  DisclosureDeliveryCorrelationToken,
  WhatsAppDeliveryKey,
  maxWhatsAppFutureTimestampMinutes,
  maxWhatsAppWebhookBytes,
} from "~/shell/channels/whatsapp/contract";
export type {
  WhatsAppInboundEvent,
  WhatsAppSendFailed,
  WhatsAppSentMessage,
  WhatsAppWebhookReceipt,
} from "~/shell/channels/whatsapp/contract";

/** Exact non-empty reviewed capabilities and finite lifetime lent to Consent publication. */
export type OAuthGrantConsentInput = Readonly<{
  id: string;
  connectionId: OAuthConnectionId;
  session: FreshSessionSubject;
  current: number;
  scopes: PATScopes;
  expiresAt: number;
}>;
/** Replay recognition is an owner-held selection rechecked in the revocation unit, never cached permission. */
export type OAuthReplayConsentInput = Readonly<{
  id: string;
  userId: UserId;
  connectionId: OAuthConnectionId;
  current: number;
  replay: OwnedStatement;
}>;
/** Owner-selected live connections for one fresh browser decision; the selection returns connection_id and user_id and is rechecked at commit. */
export type OAuthUserRevocationInput = Readonly<{
  session: FreshSessionSubject;
  current: number;
  reason: "user_one" | "user_all";
  selection: OwnedStatement;
}>;
/** Same-User grant evidence, independent of a credential owner's persistence representation. */
export type OAuthGrantConsentSubject = Readonly<{
  connectionId: OAuthConnectionId;
  userId: UserId;
}>;

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
  candidates: PATGrantSelection;
}>;

/** Fresh authenticated User whose active PAT or unclaimed pairing grants must be revoked. */
export type RevokeAllPATConsentsInput = Readonly<{
  candidates: PATGrantSelection;
  session: FreshSessionSubject;
  current: number;
}>;

/** Bounded expiry selection; current is the decision instant in Unix milliseconds. */
export type ExpirePATConsentsInput = Readonly<{ current: number; candidates: PATGrantSelection }>;

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
  table:
    | "pats"
    | "pat_pairings"
    | "web_sessions"
    | "oauth_access_credentials"
    | "oauth_refresh_credentials";
  predicate: string;
  bindings: ReadonlyArray<string | number | Uint8Array>;
}>;

/** The exact evidence that must precede a PAT owner's terminal transition in the same D1 unit. */
export type PATRevocationProtection =
  | Readonly<{ _tag: "UserPAT"; sessionId: string; occurredAtMs: Option.Option<number> }>
  | Readonly<{ _tag: "UserPairing"; sessionId: string }>
  | Readonly<{ _tag: "ExpiredPAT" }>
  | Readonly<{ _tag: "ExpiredPairing" }>;

/** A fresh User decision over Tokens-owned approved unclaimed grant references. */
export type RevokeAllPairingConsentsInput = Readonly<{
  session: FreshSessionSubject;
  current: number;
  candidates: PairingGrantSelection;
}>;

/** Bounded Tokens-owned approval selection at the server-observed expiration instant. */
export type ExpirePairingConsentsInput = Readonly<{
  current: number;
  candidates: PairingGrantSelection;
}>;
