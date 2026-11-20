import { protectQueuedStatement } from "./internal/queued-work";
import { DisclosureSnapshot } from "../../src/core/consent/contract";
import { consentResponse, withdrawProcessingConsent } from "./internal/browser";
import { renewProcessingConsent } from "./internal/renewal";
import * as proactivity from "./internal/proactivity-consent";
import type { ProactivityOptInKind } from "../../src/shell/consent/contract";
import { type ConsentProtectedStatement } from "../../src/shell/consent/contract";
import { protectConsentStatement } from "../../src/shell/consent/operations";
import { Effect, Option, Schema } from "effect";
import {
  type ConsentEgressAction,
  type ConsentEgressRefused,
  ConsentRenewalAdmission,
  type ConsentRevocationInput,
  type ConsentStanding,
  type ConsentStatus,
  type ConsentUnavailable,
  ConsentWithdrawalAdmission,
  type OnboardingConsentInput,
  type QueuedConsentAction,
} from "./contract";
import { performEgress } from "./internal/egress";
import { onboardingEvidence, revocationEvidence } from "./internal/evidence";
import { acceptedCallerProjection, operationalProjection } from "./internal/pre-user-projections";
import { loadStanding, loadStatus } from "./internal/standing";
import { withdrawalProjection } from "./internal/withdrawal-projection";
import {
  createOffer,
  createQueuedOffer,
  discloseOffer,
  findGrant,
  guardedAction,
  hasChoiceReceipt,
  latestRejection,
  prepareDecision,
  queuedAction,
  currentGrantQuery as weeklyGrantQuery,
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

const unavailableStatus = 503;

export const executeConsentRenewal = (
  input: Readonly<{ db: D1Database; candidate: unknown; userId: string; signal: AbortSignal }>
): Effect.Effect<Response> => {
  const admission = Schema.decodeUnknownOption(ConsentRenewalAdmission, {
    onExcessProperty: "error",
  })(input.candidate);
  if (Option.isNone(admission) || admission.value.userId !== input.userId) {
    return Effect.succeed(consentResponse(unavailableStatus));
  }
  return renewProcessingConsent({ ...input, admission: admission.value });
};

export const executeConsentWithdrawal = (
  input: Readonly<{
    db: D1Database;
    candidate: unknown;
    userId: string;
    signal: AbortSignal;
  }>
): Effect.Effect<Response> => {
  const admission = Schema.decodeUnknownOption(ConsentWithdrawalAdmission)(input.candidate);
  if (Option.isNone(admission) || admission.value.userId !== input.userId) {
    return Effect.succeed(consentResponse(unavailableStatus));
  }
  return withdrawProcessingConsent({ ...input, admission: admission.value });
};

export const readProactivityConsentChoiceKind: typeof proactivity.choiceKind = (choice) =>
  proactivity.choiceKind(choice);

export const hasProactivityConsentChoiceReceipt: typeof proactivity.hasChoiceReceipt = (input) =>
  proactivity.hasChoiceReceipt(input);

export const sweepProactivityConsentOffers = (
  input: Readonly<{ db: D1Database; nowEpochMs: number }>
): Effect.Effect<void, ConsentUnavailable> => proactivity.sweepOffers(input);

export const createProactivityConsentOffer = (
  input: ProactivityConsentContext
): Effect.Effect<Option.Option<ProactivityConsentOffer>, ConsentUnavailable> =>
  proactivity.createOffer({ context: input, replacement: Option.none() });

export const findCurrentProactivityOffer: typeof proactivity.findCurrentOffer = (input) =>
  proactivity.findCurrentOffer(input);

export const prepareVerifiedProactivityDisclosure: typeof proactivity.prepareVerifiedDisclosure = (
  input
) => proactivity.prepareVerifiedDisclosure(input);

export const recordProactivityConsentDisclosure = (
  input: ProactivityConsentContext &
    Readonly<{ offerId: ConsentRecordId; disclosureMessageId: string }>
): Effect.Effect<boolean, ConsentUnavailable> => proactivity.discloseOffer(input);

export const prepareProactivityConsentDecision = (
  input: ProactivityConsentContext & Readonly<{ choice: string; decisionMessageId: string }>
): Effect.Effect<Option.Option<PreparedProactivityConsentDecision>, ConsentUnavailable> =>
  proactivity.prepareDecision(input);

export const findProactivityConsentGrant = (
  input: Readonly<{ db: D1Database; userId: UserId; kind: ProactivityOptInKind }>
): Effect.Effect<Option.Option<ConsentRecord>, ConsentUnavailable> => proactivity.findGrant(input);

export const currentProactivityGrantQuery: typeof proactivity.currentGrantQuery = (input) =>
  proactivity.currentGrantQuery(input);

export const prepareProactivityConsentAction = (
  input: ProactivityConsentAction
): D1PreparedStatement => proactivity.guardedAction(input);

export const prepareQueuedProactivityConsentAction = (
  input: ProactivityConsentAction & Readonly<{ queued: QueuedConsentAction["queued"] }>
): D1PreparedStatement => proactivity.queuedAction(input);
export const prepareQueuedWeeklyConsentAction = (
  input: WeeklyConsentAction & Readonly<{ queued: QueuedConsentAction["queued"] }>
): D1PreparedStatement => queuedAction(input);

export const hasWeeklyConsentChoiceReceipt: typeof hasChoiceReceipt = (input) =>
  hasChoiceReceipt(input);

export const latestWeeklyConsentRejection: typeof latestRejection = (input) =>
  latestRejection(input);

export const createWeeklyGovernorConsentOffer = (
  input: WeeklyConsentContext & Readonly<{ request: WeeklyConsentOfferRequest }>
): Effect.Effect<Option.Option<WeeklyConsentOffer>, ConsentUnavailable> => createOffer(input);

export const recordWeeklyConsentDisclosure = (
  input: WeeklyConsentContext & Readonly<{ offerId: ConsentRecordId; disclosureMessageId: string }>
): Effect.Effect<boolean, ConsentUnavailable> => discloseOffer(input);

export const prepareWeeklyConsentDecision = (
  input: WeeklyConsentContext & Readonly<{ choice: string; decisionMessageId: string }>
): Effect.Effect<Option.Option<PreparedWeeklyConsentDecision>, ConsentUnavailable> =>
  prepareDecision(input);

export const findWeeklyConsentGrant = (
  input: Readonly<{ db: D1Database; userId: UserId }>
): Effect.Effect<Option.Option<ConsentRecord>, ConsentUnavailable> => findGrant(input);

export const prepareWeeklyConsentAction = (input: WeeklyConsentAction): D1PreparedStatement =>
  guardedAction(input);

export const createQueuedWeeklyGovernorConsentOffer = (
  input: WeeklyConsentContext &
    Readonly<{ request: WeeklyConsentOfferRequest; queued: QueuedConsentAction["queued"] }>
): Effect.Effect<Option.Option<WeeklyConsentOffer>, ConsentUnavailable> => createQueuedOffer(input);

export const readConsentStanding = (
  input: Readonly<{ db: D1Database; userId: string }>
): Effect.Effect<ConsentStanding, ConsentUnavailable> => loadStanding(input);

export const readConsentStatus = (
  input: Readonly<{ db: D1Database; userId: string }>
): Effect.Effect<ConsentStatus, ConsentUnavailable> => loadStatus(input);

export const withConsentEgress = <A, E, R>(
  input: ConsentEgressAction<A, E, R>
): Effect.Effect<A, E | ConsentEgressRefused | ConsentUnavailable, R> => performEgress(input);

export const recordOnboardingConsent = (input: OnboardingConsentInput): D1PreparedStatement =>
  onboardingEvidence(input);

export const recordConsentRevocation = (input: ConsentRevocationInput): D1PreparedStatement =>
  revocationEvidence(input);

export const prepareConsentAction = (
  input: ConsentProtectedStatement & Readonly<{ db: D1Database }>
): D1PreparedStatement => {
  const statement = protectConsentStatement(input);
  return input.db.prepare(statement.sql).bind(...statement.params);
};

export const prepareQueuedConsentAction = (input: QueuedConsentAction): D1PreparedStatement => {
  const statement = protectQueuedStatement(input);
  return input.db.prepare(statement.sql).bind(...statement.params);
};

export const prepareConsentWithdrawalProjection = (
  input: Readonly<{ db: D1Database; statement: ConsentProtectedStatement["statement"] }>
): D1PreparedStatement =>
  input.db
    .prepare(`${withdrawalProjection}
${input.statement.sql}`)
    .bind(...input.statement.params);

export const prepareAcceptedConsentCaller = (
  input: Readonly<{ db: D1Database; statement: ConsentProtectedStatement["statement"] }>
): D1PreparedStatement =>
  input.db
    .prepare(`${acceptedCallerProjection}
${input.statement.sql}`)
    .bind(...input.statement.params);

export const prepareConsentOperationalMetadata = (
  input: Readonly<{ db: D1Database; statement: ConsentProtectedStatement["statement"] }>
): D1PreparedStatement =>
  input.db
    .prepare(`${operationalProjection}
${input.statement.sql}`)
    .bind(...input.statement.params);

export const replaceProactivityConsentOffer = (
  input: ProactivityConsentContext & Readonly<{ replacement: ProactivityOfferReplacement }>
): Effect.Effect<Option.Option<ProactivityConsentOffer>, ConsentUnavailable> =>
  proactivity.createOffer({ context: input, replacement: Option.some(input.replacement) });

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
      `INSERT INTO consent_history (record_type,id,user_id,disclosure_json,disclosure_message_id,decision_message_id,decision_received_at_ms,occurred_at_ms) VALUES ('processing_grant',?,?,?,?,?,?,?)`
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

export const currentWeeklyGrantQuery: typeof weeklyGrantQuery = (input) => weeklyGrantQuery(input);
