import { type TranscriptTurnId } from "@fidy/server/agent-contract";
import { type OnboardingConsentBasis } from "@fidy/server/consent-contract";
import { Data, type Effect, type Option } from "effect";

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

/** Pre-User Consent work is reached only after the WhatsApp owner authenticates exact inbound bytes. */
export type ConsentIngressEnvironment = Readonly<{
  DB: D1Database;
  KAPSO_API_KEY: string;
  onAccepted: (id: string) => void;
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
