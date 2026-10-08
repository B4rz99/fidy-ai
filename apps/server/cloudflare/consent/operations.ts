import { DisclosureSnapshot } from "../../src/core/consent/contract";
import * as proactivity from "./internal/proactivity-consent";
import type { ProactivityOptInKind } from "../../src/shell/consent/contract";
import { type ConsentProtectedStatement } from "../../src/shell/consent/contract";
import { protectConsentStatement } from "../../src/shell/consent/operations";
import { type Effect, Option, Schema } from "effect";
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
  PreparedProactivityConsentDecision,
  PreparedWeeklyConsentDecision,
  ProactivityConsentAction,
  ProactivityConsentContext,
  ProactivityConsentOffer,
  ProactivityOfferReplacement,
  WeeklyConsentAction,
  WeeklyConsentContext,
  WeeklyConsentOffer,
  WeeklyConsentOfferRequest,
} from "./contract";
import type { ConsentRecord, ConsentRecordId } from "../../src/core/consent/contract";
import type { UserId } from "../../src/core/identity/contract";

/** Decode only a complete qualified category choice; a category identity carries no decision authority. */
export const readProactivityConsentChoiceKind: typeof proactivity.choiceKind = (choice) =>
  proactivity.choiceKind(choice);
/** Recognize exact same-User authenticated privacy-choice retries without granting permission or relying on provider/model availability. */
export const hasProactivityConsentChoiceReceipt: typeof proactivity.hasChoiceReceipt = (input) =>
  proactivity.hasChoiceReceipt(input);

/** Independently erase at most 64 undecided expired offers after one further day. Accepted/rejected decisions and referenced legal evidence are not erased by operational cleanup. */
export const sweepProactivityConsentOffers = (
  input: Readonly<{ db: D1Database; nowEpochMs: number }>
): Effect.Effect<void, ConsentUnavailable> => proactivity.sweepOffers(input);

/** Create one bounded category-specific disclosure offer for an established authenticated WhatsAppIdentity under processing Consent. No delivery grant is inferred. */
export const createProactivityConsentOffer = (
  input: ProactivityConsentContext
): Effect.Effect<Option.Option<ProactivityConsentOffer>, ConsentUnavailable> =>
  proactivity.createOffer({ context: input, replacement: Option.none() });

/** Reuse one still-live authenticated category disclosure after interrupted contextual delivery preparation. */
export const findCurrentProactivityOffer: typeof proactivity.findCurrentOffer = (input) =>
  proactivity.findCurrentOffer(input);

/** Compose authenticated exact offer delivery evidence with owner settlement; acceptance alone never establishes disclosure. */
export const prepareVerifiedProactivityDisclosure: typeof proactivity.prepareVerifiedDisclosure = (
  input
) => proactivity.prepareVerifiedDisclosure(input);

/** Retain the exact disclosure message id only from authenticated native channel send evidence, never a model or canonical caller. */
export const recordProactivityConsentDisclosure = (
  input: ProactivityConsentContext &
    Readonly<{ offerId: ConsentRecordId; disclosureMessageId: string }>
): Effect.Effect<boolean, ConsentUnavailable> => proactivity.discloseOffer(input);

/** Prepare an exchange-qualified same-User choice. Commit legal evidence and execution standing together under the User coordinator; this is not a PAT or tool operation. */
export const prepareProactivityConsentDecision = (
  input: ProactivityConsentContext & Readonly<{ choice: string; decisionMessageId: string }>
): Effect.Effect<Option.Option<PreparedProactivityConsentDecision>, ConsentUnavailable> =>
  proactivity.prepareDecision(input);

/** Observe category-specific historical legal standing, including for privacy controls after processing Consent withdrawal; returned evidence grants no later send authority. */
export const findProactivityConsentGrant = (
  input: Readonly<{ db: D1Database; userId: UserId; kind: ProactivityOptInKind }>
): Effect.Effect<Option.Option<ConsentRecord>, ConsentUnavailable> => proactivity.findGrant(input);

/** Project only a current live grant identity for atomic detection-time eligibility capture. A later grant cannot alter the committed fact. */
export const currentProactivityGrantQuery: typeof proactivity.currentGrantQuery = (input) =>
  proactivity.currentGrantQuery(input);

/** Recheck the exact live category grant and current processing Consent in a caller-owned atomic action. */
export const prepareProactivityConsentAction = (
  input: ProactivityConsentAction
): D1PreparedStatement => proactivity.guardedAction(input);

/** Recognize an already applied qualified privacy choice without starting another operation. */
export const hasWeeklyConsentChoiceReceipt: typeof hasChoiceReceipt = (input) =>
  hasChoiceReceipt(input);

/** Snapshot the latest same-User rejection so an older requested prompt cannot bypass a later no. */
export const latestWeeklyConsentRejection: typeof latestRejection = (input) =>
  latestRejection(input);

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

/** Replace only an undisclosed native offer, guarded by owner-qualified definitive failure evidence in the insertion unit. */
export const replaceProactivityConsentOffer = (
  input: ProactivityConsentContext & Readonly<{ replacement: ProactivityOfferReplacement }>
): Effect.Effect<Option.Option<ProactivityConsentOffer>, ConsentUnavailable> =>
  proactivity.createOffer({ context: input, replacement: Option.some(input.replacement) });

/** Append the exact accepted web disclosure for the proven provider origin in the caller's atomic onboarding unit. A public reference alone is never evidence. */
export const recordWebOnboardingConsent = (
  input: Readonly<{
    db: D1Database;
    userId: UserId;
    attemptId: string;
    disclosure: DisclosureSnapshot;
    acceptedAtMs: number;
  }>
): D1PreparedStatement =>
  input.db
    .prepare(
      `INSERT INTO onboarding_consent_records(id,user_id,disclosure_json,disclosure_message_id,decision_message_id,decision_received_at_ms,accepted_at_ms) VALUES(?,?,?,?,?,?,?)`
    )
    .bind(
      input.attemptId,
      input.userId,
      Schema.encodeSync(Schema.fromJsonString(DisclosureSnapshot))(input.disclosure),
      `web:${input.attemptId}`,
      `web:${input.attemptId}`,
      input.acceptedAtMs,
      input.acceptedAtMs
    );
