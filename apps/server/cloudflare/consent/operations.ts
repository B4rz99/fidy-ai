import { acceptedCallerProjection, operationalProjection } from "./internal/pre-user-projections";
import { withdrawalProjection } from "./internal/withdrawal-projection";
import { protectConsentStatement } from "@fidy/server/consent-operations";
import type { ConsentProtectedStatement } from "@fidy/server/consent-contract";
import { onboardingEvidence, revocationEvidence } from "./internal/evidence";
import { performEgress } from "./internal/egress";
import type { Effect } from "effect";
import type {
  ConsentEgressAction,
  ConsentEgressRefused,
  ConsentRevocationInput,
  ConsentStanding,
  ConsentStatus,
  ConsentUnavailable,
  OnboardingConsentInput,
} from "./contract";
import { loadStanding, loadStatus } from "./internal/standing";

/**
 * Read the exact historical Consent basis for the explicit User. This is admission evidence,
 * never authorization to execute a later action; protected actions recheck inside their D1 unit.
 */
export const readConsentStanding = (
  input: Readonly<{ db: D1Database; userId: string }>
): Effect.Effect<ConsentStanding, ConsentUnavailable> => loadStanding(input);

/** Classify an already-refused action without interpreting private evidence or changing authority. */
export const readConsentStatus = (
  input: Readonly<{ db: D1Database; userId: string }>
): Effect.Effect<ConsentStatus, ConsentUnavailable> => loadStatus(input);

/**
 * Execute one bounded provider action after rechecking its exact current Consent purpose under
 * the existing User coordinator. No provider action runs in a D1 transaction. An admitted Pending
 * Turn retains its historical basis through revocation; foreign or terminal Turns grant no authority.
 * Refusal and unreadable authority never invoke the action; action failures retain their own type.
 */
export const withConsentEgress = <A, E, R>(
  input: ConsentEgressAction<A, E, R>
): Effect.Effect<A, E | ConsentEgressRefused | ConsentUnavailable, R> => performEgress(input);

/**
 * Append the accepted pre-User decision to the newly verified User in the caller's onboarding
 * batch. The identity, mailbox proof, historical disclosure and recovery evidence commit together.
 */
export const recordOnboardingConsent = (input: OnboardingConsentInput): D1PreparedStatement =>
  onboardingEvidence(input);

/**
 * Append withdrawal for the same live authenticated User, once. Compose in the existing User
 * coordinator's D1 batch; no provider call belongs in that unit. Replays append no new evidence.
 */
export const recordConsentRevocation = (input: ConsentRevocationInput): D1PreparedStatement =>
  revocationEvidence(input);

/** Bind one protected owner action; its current Consent guard executes with the action in D1. */
export const prepareConsentAction = (
  input: ConsentProtectedStatement & Readonly<{ db: D1Database }>
): D1PreparedStatement => {
  const statement = protectConsentStatement(input);
  return input.db.prepare(statement.sql).bind(...statement.params);
};

/**
 * Prepare one caller-owned action with a `consent_withdrawals(user_id)` relation that reflects
 * withdrawal when the action executes. The caller owns its subject restrictions, retention,
 * classification, ordering, and mutations; no Consent evidence or intermediate check is returned.
 * Supply one statement without a leading WITH, and commit it in the caller's existing D1 unit.
 */
export const prepareConsentWithdrawalProjection = (
  input: Readonly<{ db: D1Database; statement: ConsentProtectedStatement["statement"] }>
): D1PreparedStatement =>
  input.db
    .prepare(`${withdrawalProjection}
${input.statement.sql}`)
    .bind(...input.statement.params);

/**
 * Compose the accepted caller projection with the Identity owner's bootstrap action. Only
 * exchange_id, portfolio_id, and bsuid are available through accepted_consent_callers; the caller
 * keeps its exact exchange restriction and commits the action in the verified-onboarding D1 unit.
 */
export const prepareAcceptedConsentCaller = (
  input: Readonly<{ db: D1Database; statement: ConsentProtectedStatement["statement"] }>
): D1PreparedStatement =>
  input.db
    .prepare(`${acceptedCallerProjection}
${input.statement.sql}`)
    .bind(...input.statement.params);

/**
 * Compose metadata-only pending-delivery and expiry instants with an operational health query.
 * consent_pending_deliveries(created_at_ms) and consent_expiry_deadlines(expires_at_ms) expose no
 * caller or decision evidence; the health owner retains its time filters, ordering, and sample cap.
 */
export const prepareConsentOperationalMetadata = (
  input: Readonly<{ db: D1Database; statement: ConsentProtectedStatement["statement"] }>
): D1PreparedStatement =>
  input.db
    .prepare(`${operationalProjection}
${input.statement.sql}`)
    .bind(...input.statement.params);
