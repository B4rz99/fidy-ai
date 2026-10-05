import { type TranscriptTurnId } from "../../src/core/agent/contract";
import {
  type OnboardingConsentBasis,
  type ProactivityOptInKind,
} from "../../src/shell/consent/contract";
import { Data, type DateTime, type Effect, type Option, Schema } from "effect";
import { ConsentRecordId, DisclosureSnapshot } from "../../src/core/consent/contract";
import type { UserId, WhatsAppCallerReference } from "../../src/core/identity/contract";
import { type OwnedStatement } from "../../src/shell/owner-write/contract";

/** Established authenticated native channel and explicit category, never model or PAT decision authority. */
export type ProactivityConsentContext = Readonly<{
  db: D1Database;
  userId: UserId;
  caller: WhatsAppCallerReference;
  kind: ProactivityOptInKind;
  now: DateTime.Utc;
}>;

/** Delivered exact disclosure with exchange-qualified explicit choices. */
export type ProactivityConsentOffer = Readonly<{
  id: ConsentRecordId;
  disclosure: DisclosureSnapshot;
  acceptChoice: string;
  declineChoice: string;
  revokeChoice: string;
}>;

/** Compose legal evidence with the same category's execution standing in one caller-owned User-coordinated atomic unit. */
export type PreparedProactivityConsentDecision = Readonly<{
  decision: "accept" | "continue" | "decline" | "revoke";
  kind: ProactivityOptInKind;
  grantId: Option.Option<ConsentRecordId>;
  statements: ReadonlyArray<D1PreparedStatement>;
}>;

/** Protect a caller-owned statement with the exact live category grant and processing Consent. */
export type ProactivityConsentAction = Readonly<{
  db: D1Database;
  userId: UserId;
  kind: ProactivityOptInKind;
  grantId: ConsentRecordId;
  statement: OwnedStatement;
}>;

/** Offer purpose and retry identity are explicit; short offers have no durable governor source. */
export type WeeklyConsentOfferRequest =
  | Readonly<{ _tag: "ShortOffer"; origin: "proactive" }>
  | (Readonly<{ _tag: "GovernorQuestion"; sourceId: string }> &
      (
        | Readonly<{ origin: "proactive" }>
        | Readonly<{
            origin: "requested";
            requestedAt: DateTime.Utc;
            rejectionOfferId: Option.Option<ConsentRecordId>;
          }>
      ));

/** Opaque exchange identity binds a fixed explicit choice to one exact delivered disclosure. */
export const WeeklyConsentOffer = Schema.Struct({
  id: ConsentRecordId,
  disclosure: DisclosureSnapshot,
  acceptChoice: Schema.String,
  declineChoice: Schema.String,
  revokeChoice: Schema.String,
});
export type WeeklyConsentOffer = typeof WeeklyConsentOffer.Type;

/** Authenticated native channel context; never exposed as a canonical tool or PAT operation. */
export type WeeklyConsentContext = Readonly<{
  db: D1Database;
  userId: UserId;
  caller: WhatsAppCallerReference;
  now: DateTime.Utc;
}>;

/** An owner action ending at its WHERE condition; protected standing is re-evaluated at commit. */
export type WeeklyConsentAction = Readonly<{
  db: D1Database;
  userId: UserId;
  grantId: ConsentRecordId;
  statement: OwnedStatement;
}>;

/** Prepared same-User decision. The orchestrator must commit these statements and schedule enable/disable atomically under User coordination. */
export type PreparedWeeklyConsentDecision = Readonly<{
  decision: "accept" | "continue" | "decline" | "revoke";
  grantId: Option.Option<ConsentRecordId>;
  statements: ReadonlyArray<D1PreparedStatement>;
}>;

/** A current decision for one explicit User; absence never borrows another User's grant. */
export type ConsentStatus = "Missing" | "Granted" | "Revoked";

/** The exact historical grant remains available for admission even after its revocation. */
export type ConsentStanding =
  | Readonly<{ _tag: "Missing"; subjectUserId: string }>
  | Readonly<{ _tag: "Granted" | "Revoked"; subjectUserId: string; basis: OnboardingConsentBasis }>;

/** A closed Consent boundary failure; no private row, statement or provider data escapes. */
export class ConsentUnavailable extends Data.TaggedError("ConsentUnavailable")<{}> {}

/** The current purpose does not authorize this action; no content or private evidence escapes. */
export class ConsentEgressRefused extends Data.TaggedError("ConsentEgressRefused")<{}> {}

/** A bounded provider action run under the existing User coordinator's serialized work. */
export type ConsentEgressAction<A, E, R> = Readonly<{
  db: D1Database;
  userId: string;
  admittedTurnId: Option.Option<TranscriptTurnId>;
  action: Effect.Effect<A, E, R>;
}>;

/** Stable subject and accepted pre-User exchange composed in verified onboarding. */
export type OnboardingConsentInput = Readonly<{
  db: D1Database;
  userId: string;
  exchangeId: string;
}>;

/** Authenticated withdrawal evidence; credentials are checked with the append, never retained. */
export type ConsentRevocationInput = Readonly<{
  db: D1Database;
  subject: Readonly<{ id: string; userId: string; digest: Uint8Array }>;
  evidenceId: string;
  current: number;
}>;
