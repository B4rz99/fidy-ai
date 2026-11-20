import { type TranscriptTurnId } from "../../src/core/agent/contract";
import {
  type OnboardingConsentBasis,
  type ProactivityOptInKind,
} from "../../src/shell/consent/contract";
import { Data, type DateTime, type Effect, type Option, Schema } from "effect";
import { ConsentRecordId, DisclosureSnapshot } from "../../src/core/consent/contract";
import { UserId, type WhatsAppCallerReference } from "../../src/core/identity/contract";
import { WebSessionId } from "../../src/core/web-session/contract";
import { ProcessingConsentRenewal } from "../../src/shell/processing-consent/contract";

import { type OwnedStatement } from "../../src/shell/owner-write/contract";

const digestLength = 32;

export type QueuedConsentAction = Readonly<{
  db: D1Database;
  userId: string;
  queued: OwnedStatement;
  statement: OwnedStatement;
}>;

export const ConsentWithdrawalAdmission = Schema.Struct({
  userId: UserId,
  sessionId: WebSessionId,
  digest: Schema.Array(Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 255 }))).check(
    Schema.isBetweenLength(digestLength, digestLength)
  ),
  deadlineMilliseconds: Schema.Int,
});

export const ConsentRenewalAdmission = Schema.Struct({
  ...ConsentWithdrawalAdmission.fields,
  renewal: ProcessingConsentRenewal,
});

export type ProactivityConsentContext = Readonly<{
  db: D1Database;
  userId: UserId;
  caller: WhatsAppCallerReference;
  kind: ProactivityOptInKind;
  now: DateTime.Utc;
}>;

export type ProactivityConsentOffer = Readonly<{
  id: ConsentRecordId;
  expiresAt: DateTime.Utc;
  disclosure: DisclosureSnapshot;
  acceptChoice: string;
  declineChoice: string;
  revokeChoice: string;
}>;

export type PreparedProactivityConsentDecision = Readonly<{
  kind: ProactivityOptInKind;
  statements: ReadonlyArray<D1PreparedStatement>;
}> &
  (
    | Readonly<{ decision: "accept" | "continue" | "revoke"; grantId: ConsentRecordId }>
    | Readonly<{ decision: "decline" }>
  );

export type ProactivityConsentAction = Readonly<{
  db: D1Database;
  userId: UserId;
  kind: ProactivityOptInKind;
  grantId: ConsentRecordId;
  statement: OwnedStatement;
}>;

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

export const WeeklyConsentOffer = Schema.Struct({
  id: ConsentRecordId,
  disclosure: DisclosureSnapshot,
  acceptChoice: Schema.String,
  declineChoice: Schema.String,
  revokeChoice: Schema.String,
});
export type WeeklyConsentOffer = typeof WeeklyConsentOffer.Type;

export type WeeklyConsentContext = Readonly<{
  db: D1Database;
  userId: UserId;
  caller: WhatsAppCallerReference;
  now: DateTime.Utc;
}>;

export type WeeklyConsentAction = Readonly<{
  db: D1Database;
  userId: UserId;
  grantId: ConsentRecordId;
  statement: OwnedStatement;
}>;

export type PreparedWeeklyConsentDecision = Readonly<{
  decision: "accept" | "continue" | "decline" | "revoke";
  grantId: Option.Option<ConsentRecordId>;
  statements: ReadonlyArray<D1PreparedStatement>;
}>;

export type ConsentStatus = "Missing" | "Granted" | "Revoked";

export type ConsentStanding =
  | Readonly<{ _tag: "Missing"; subjectUserId: string }>
  | Readonly<{ _tag: "Granted" | "Revoked"; subjectUserId: string; basis: OnboardingConsentBasis }>;

export class ConsentUnavailable extends Data.TaggedError("ConsentUnavailable")<{}> {}

export class ConsentEgressRefused extends Data.TaggedError("ConsentEgressRefused")<{}> {}

export type ConsentEgressAction<A, E, R> = Readonly<{
  db: D1Database;
  userId: string;
  admittedTurnId: Option.Option<TranscriptTurnId>;
  action: Effect.Effect<A, E, R>;
}>;

export type OnboardingConsentInput = Readonly<{
  db: D1Database;
  userId: string;
  exchangeId: string;
}>;

export type ConsentRevocationInput = Readonly<{
  db: D1Database;
  subject: Readonly<{ id: string; userId: string; digest: Uint8Array }>;
  evidenceId: string;
  current: number;
}>;

export type ProactivityOfferReplacement = Readonly<{
  offerId: ConsentRecordId;
  proof: OwnedStatement;
}>;
