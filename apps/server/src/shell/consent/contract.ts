import { Data, type Option, Schema } from "effect";
import type { UserId } from "~/core/identity/contract";
import type { OAuthConnectionId } from "~/core/oauth-agents/contract";
import type { PATScopes } from "~/core/tokens/contract";
import { DisclosureSnapshot } from "~/core/consent/contract";
import { type OwnedStatement } from "~/shell/owner-write/contract";
import { type PATGrantSelection, type PairingGrantSelection } from "~/shell/tokens/contract";
import { type FreshSessionSubject } from "~/shell/web-session/contract";

export const ProactivityOptInKind = Schema.Literals([
  "budget-threshold",
  "manual-entry-reminder",
  "new-recurring-series",
]);

export type ProactivityOptInKind = typeof ProactivityOptInKind.Type;

export { E164PhoneNumber } from "~/core/identity/contract";

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

export type OAuthGrantConsentInput = Readonly<{
  id: string;
  connectionId: OAuthConnectionId;
  session: FreshSessionSubject;
  current: number;
  scopes: PATScopes;
  expiresAt: number;
}>;

export type OAuthReplayConsentInput = Readonly<{
  id: string;
  userId: UserId;
  connectionId: OAuthConnectionId;
  current: number;
  replay: OwnedStatement;
}>;

export type OAuthUserRevocationInput = Readonly<{
  session: FreshSessionSubject;
  current: number;
  reason: "user_one" | "user_all";
  selection: OwnedStatement;
}>;

export type OAuthGrantConsentSubject = Readonly<{
  connectionId: OAuthConnectionId;
  userId: UserId;
}>;

export const PendingDisclosureJson = Schema.fromJsonString(Schema.toCodecJson(DisclosureSnapshot));

export type RevokeOnePATConsentInput = Readonly<{
  session: FreshSessionSubject;
  input: Readonly<{ id: string; shortId: string; current: number }>;
  candidates: PATGrantSelection;
}>;

export type RevokeAllPATConsentsInput = Readonly<{
  candidates: PATGrantSelection;
  session: FreshSessionSubject;
  current: number;
}>;

export type ExpirePATConsentsInput = Readonly<{ current: number; candidates: PATGrantSelection }>;

export type ManualPATConsentInput = Readonly<{
  session: FreshSessionSubject;
  input: Readonly<{ id: string; requestId: string; disclosure: string; current: number }>;
}>;

export type PairedPATConsentInput = Readonly<{
  session: FreshSessionSubject;
  input: Readonly<{ id: string; pairingId: string; disclosure: string; current: number }>;
}>;

export type ConsentSubjectColumn =
  | "web_sessions.user_id"
  | "pats.user_id"
  | "pat_pairings.user_id"
  | "users.id"
  | "u.id"
  | "r.user_id"
  | "o.user_id"
  | "a.user_id"
  | "a.id"
  | "w.user_id"
  | "s.user_id"
  | "transactions.user_id"
  | "forwarded_email_receipts.user_id";

export type ConsentSubject =
  | Readonly<{ _tag: "User"; userId: string }>
  | Readonly<{ _tag: "Owner"; column: ConsentSubjectColumn }>;

export const ConsentSubject = Data.taggedEnum<ConsentSubject>();

export type ConsentStandingRequirement = "granted" | "unrevoked" | "active";

export type ConsentProtectedStatement = Readonly<{
  statement: OwnedStatement;
  subject: ConsentSubject;
  requirement: ConsentStandingRequirement;
}>;

export type ConsentAuthority = Readonly<{
  table: "pats" | "pat_pairings" | "web_sessions" | "oauth_credentials";
  predicate: string;
  bindings: ReadonlyArray<string | number | Uint8Array>;
}>;

export type PATRevocationProtection =
  | Readonly<{ _tag: "UserPAT"; sessionId: string; occurredAtMs: Option.Option<number> }>
  | Readonly<{ _tag: "UserPairing"; sessionId: string }>
  | Readonly<{ _tag: "ExpiredPAT" }>
  | Readonly<{ _tag: "ExpiredPairing" }>;

export type RevokeAllPairingConsentsInput = Readonly<{
  session: FreshSessionSubject;
  current: number;
  candidates: PairingGrantSelection;
}>;

export type ExpirePairingConsentsInput = Readonly<{
  current: number;
  candidates: PairingGrantSelection;
}>;
