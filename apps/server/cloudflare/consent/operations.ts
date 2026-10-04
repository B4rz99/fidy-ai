import { type ConsentProtectedStatement } from "../../src/shell/consent/contract";
import { protectConsentStatement } from "../../src/shell/consent/operations";
import { type Effect } from "effect";
import {
  type ConsentEgressAction,
  type ConsentEgressRefused,
  type ConsentRevocationInput,
  type ConsentStanding,
  type ConsentStatus,
  type ConsentUnavailable,
  type OnboardingConsentInput,
} from "./contract";
import { performEgress } from "./internal/egress";
import { onboardingEvidence, revocationEvidence } from "./internal/evidence";
import { acceptedCallerProjection, operationalProjection } from "./internal/pre-user-projections";
import { loadStanding, loadStatus } from "./internal/standing";
import { withdrawalProjection } from "./internal/withdrawal-projection";
import {
  createOffer,
  discloseOffer,
  findGrant,
  guardedAction,
  hasChoiceReceipt,
  latestRejection,
  prepareDecision,
} from "./internal/weekly-consent";
import type {
  PreparedWeeklyConsentDecision,
  WeeklyConsentAction,
  WeeklyConsentContext,
  WeeklyConsentOffer,
  WeeklyConsentOfferRequest,
} from "./contract";
import type { ConsentRecord, ConsentRecordId } from "../../src/core/consent/contract";
import type { UserId } from "../../src/core/identity/contract";
import type { Option } from "effect";

/** Recognize an already applied qualified privacy choice without starting another operation. */
export const hasWeeklyConsentChoiceReceipt: typeof hasChoiceReceipt = (input) =>
  hasChoiceReceipt(input);

/** Snapshot the latest same-User rejection so an older requested prompt cannot bypass a later no. */
export const latestWeeklyConsentRejection: typeof latestRejection = (input) =>
  latestRejection(input);

/** Begin a bounded contextual offer for an authenticated established WhatsAppIdentity. No grant is recorded. */
export const createWeeklyConsentOffer = (
  input: WeeklyConsentContext
): Effect.Effect<Option.Option<WeeklyConsentOffer>, ConsentUnavailable> =>
  createOffer({ ...input, request: { _tag: "ShortOffer", origin: "proactive" } });

/** Durable governor questions retain their exact retry identity and a bounded 24-hour choice lifetime. */
export const createWeeklyGovernorConsentOffer = (
  input: WeeklyConsentContext & Readonly<{ request: WeeklyConsentOfferRequest }>
): Effect.Effect<Option.Option<WeeklyConsentOffer>, ConsentUnavailable> => createOffer(input);

/** The native channel calls this only after sending the offer's exact fixed disclosure; model claims cannot call this seam. */
export const recordWeeklyConsentDisclosure = (
  input: WeeklyConsentContext & Readonly<{ offerId: ConsentRecordId; disclosureMessageId: string }>
): Effect.Effect<boolean, ConsentUnavailable> => discloseOffer(input);

/** Prepare an exact authenticated choice without committing authority. Commit together with schedule enable/disable under User coordination; stale, foreign or replayed choices refuse without partial effects. */
export const prepareWeeklyConsentDecision = (
  input: WeeklyConsentContext & Readonly<{ choice: string; decisionMessageId: string }>
): Effect.Effect<Option.Option<PreparedWeeklyConsentDecision>, ConsentUnavailable> =>
  prepareDecision(input);

/** Decoded same-User grant evidence; it is a snapshot, not permission for later work. */
export const findWeeklyConsentGrant = (
  input: Readonly<{ db: D1Database; userId: UserId }>
): Effect.Effect<Option.Option<ConsentRecord>, ConsentUnavailable> => findGrant(input);

/** Add current processing Consent and this exact live weekly grant to a caller-owned atomic action. */
export const prepareWeeklyConsentAction = (input: WeeklyConsentAction): D1PreparedStatement =>
  guardedAction(input);

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
