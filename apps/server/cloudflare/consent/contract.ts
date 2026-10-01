import type { WhatsAppStatusAdmission, WhatsAppTurnAdmission } from "../agent/whatsapp-turn";
import { Data, type Effect, type Option } from "effect";
import type { TranscriptTurnId } from "@fidy/server/agent-runtime";
import type { OnboardingConsentBasis } from "@fidy/server/consent-contract";

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

/** Binding and callbacks required by the authenticated Consent ingress composition. */
export type ConsentIngressEnvironment = Readonly<{
  readonly DB: D1Database;
  readonly KAPSO_API_KEY: string;
  readonly KAPSO_WEBHOOK_SECRET: string;
  readonly WHATSAPP_BUSINESS_PORTFOLIO_ID: string;
  readonly onAccepted: (id: string) => void;
  readonly onHostedText: (admission: WhatsAppTurnAdmission) => Promise<Response>;
  readonly onHostedStatus: (admission: WhatsAppStatusAdmission) => Promise<Response>;
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
