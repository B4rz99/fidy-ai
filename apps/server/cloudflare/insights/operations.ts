import type { RecurringDigestAdvanceResult } from "./contract";
import { requestDiscoveryOffer } from "./internal/recurring-offer";
import * as recurringGeneration from "./internal/recurring-generation";
import { type RecurringDigestReport } from "../../src/core/insights/contract";
import * as recurringStanding from "./internal/recurring-standing";
import {
  controlReminder as controlReminderOwned,
  findGovernor as findReminderGovernorOwned,
  prepareDelivery as prepareReminderDeliveryOwned,
  prepareNoticeCompletion as prepareReminderNoticeCompletionOwned,
  prepareNotice as prepareReminderNoticeOwned,
  prepareReply as prepareReminderReplyOwned,
  readNotice as readReminderNoticeOwned,
} from "./internal/reminder-governor";
import { requestOffer } from "./internal/proactivity-offers";
import { evaluateBudgetAlerts, prepareBudgetOptInFence } from "../budgets/operations";
import {
  findReport as findProactivityReportOwned,
  prepareSettlement,
  transcriptLinksQuery,
  transcriptOccurrenceQuery,
} from "./internal/proactivity-reports";

import {
  prepareCanonicalReminderRevision as prepareCanonicalReminderRevisionOwned,
  prepareHeldReminderRevision as prepareHeldReminderRevisionOwned,
  readCanonicalRecurringDigestReport as readCanonicalDigestOwned,
  readCanonicalReminderSchedule as readCanonicalReminderScheduleOwned,
  readHeldRecurringDigestReport as readHeldDigestOwned,
  readHeldReminderSchedule as readHeldReminderScheduleOwned,
  reminderRevisionRefusal as reminderRevisionRefusalOwned,
} from "./internal/reminder-canonical";
import { weeklyThresholds } from "./internal/weekly-execution";
import { requestQuestion } from "./internal/proactivity-delivery-work";
import {
  findGovernor,
  prepareNotice,
  prepareNoticeCompletion,
  prepareQuestionDelivered,
  prepareReply,
  prepareReset,
  readNotice,
} from "./internal/weekly-governor";
import { prepareWeeklyDeliverySettlement as prepareWeeklyDeliverySettlementOwned } from "./internal/weekly-settlement";
import { type DateTime, Effect, Option } from "effect";
import * as reminder from "./internal/reminder-schedule";
import type { ReminderSchedule, ReminderScheduleEdit } from "../../src/core/insights/contract";
import type {
  PreparedProactivityConsentDecision,
  ProactivityConsentContext,
} from "../consent/contract";
import { type InsightEventId, type ScheduleId } from "../../src/core/insights/contract";
import {
  prepareProactivityConsentDecision,
  prepareWeeklyConsentDecision,
} from "../consent/operations";
import { type WeeklyConsentContext } from "../consent/contract";
import {
  type DueWeeklySchedule,
  InsightUnavailable,
  type ReminderMaterialization,
  type ReminderRevisionConflict,
  type WeeklyMaterialization,
  type WeeklyOccurrenceGuard,
  type WeeklyScheduleAdvance,
  type WeeklyScheduleSnapshot,
  type WeeklySummaryReport,
} from "./contract";
import {
  discoverSchedules,
  findSchedule,
  noteScheduleEvaluation,
  occurrenceGuard,
  prepareScheduleDisable,
  prepareScheduleEnable,
  scheduleAdvance,
} from "./internal/weekly-schedule";
import {
  findReport,
  materialize,
  weeklyReportDeliveryQuery as weeklyReportDeliveryQueryOwned,
} from "./internal/weekly-generation";
import type { UserId } from "../../src/core/identity/contract";
import {
  discoverDueInsights as discover,
  findInsight as find,
  findInsightAttempt as findAttempt,
  generateInsight as generate,
  listPendingInsights as list,
  prepareInsightTransition as prepare,
  insightRefusal as refuse,
} from "./internal/insight-store";

/** Apply only an authenticated exact current-question continue/stop choice; operational state never grants or revokes legal Consent. */
export const controlManualReminders: typeof controlReminderOwned = (input) =>
  controlReminderOwned(input);

/** Observe independent reminder-only attention under current processing Consent. */
export const findReminderGovernor: typeof findReminderGovernorOwned = (input) =>
  findReminderGovernorOwned(input);
/** Compose one-shot verified reminder/question evidence with exact Transcript settlement. */
export const prepareReminderDelivery: typeof prepareReminderDeliveryOwned = (input) =>
  prepareReminderDeliveryOwned(input);
/** Reset only from same-User channel-qualified reminder/question reply evidence. */
export const prepareReminderReply: typeof prepareReminderReplyOwned = (input) =>
  prepareReminderReplyOwned(input);
/** Bind an operational pause mention to an admitted User request, never a scheduler Turn. */
export const prepareReminderPauseNotice: typeof prepareReminderNoticeOwned = (input) =>
  prepareReminderNoticeOwned(input);
/** Observe only the notice bound to this admitted same-User Turn. */
export const readReminderPauseNotice: typeof readReminderNoticeOwned = (input) =>
  readReminderNoticeOwned(input);
/** Mark the mention complete only from verified exact visible assistant evidence. */
export const prepareReminderPauseNoticeCompletion: typeof prepareReminderNoticeCompletionOwned = (
  input
) => prepareReminderNoticeCompletionOwned(input);

/** Record an authenticated exact category request for durable contextual disclosure, never a legal grant. */
export const requestProactivityConsent: typeof requestOffer = (input) => requestOffer(input);

/** Observe one same-User frozen category payload under current processing Consent; this snapshot grants no send authority. */
export const findProactivityReport: typeof findProactivityReportOwned = (input) =>
  findProactivityReportOwned(input);

/** Settle linked occurrences and outbox from authenticated channel evidence in the caller's atomic Transcript unit. */
export const prepareProactivityDeliverySettlement: typeof prepareSettlement = (input) =>
  prepareSettlement(input);
/** Supply the primary retained occurrence and exact channel text without exposing Insights persistence. */
export const proactivityTranscriptOccurrenceQuery: typeof transcriptOccurrenceQuery = (input) =>
  transcriptOccurrenceQuery(input);

/** All same-User occurrence links for one verified message, for atomic Agent-owned Transcript linking. */
export const proactivityTranscriptLinksQuery: typeof transcriptLinksQuery = (input) =>
  transcriptLinksQuery(input);

/** Read instructions under the canonical caller's live authority and required Audit. */
export const readCanonicalReminderSchedule: typeof readCanonicalReminderScheduleOwned = (input) =>
  readCanonicalReminderScheduleOwned(input);
/** Compose instruction revisions, current credential/Consent, optimistic version and required Audit in canonical execution. Never grants opt-in. */
export const prepareCanonicalReminderRevision: typeof prepareCanonicalReminderRevisionOwned = (
  input
) => prepareCanonicalReminderRevisionOwned(input);
/** The same read under Agent's published current Turn authority. */
export const readHeldReminderSchedule: typeof readHeldReminderScheduleOwned = (input) =>
  readHeldReminderScheduleOwned(input);
/** The same revision under Agent's current Turn authority and confirmation fence. */
export const prepareHeldReminderRevision: typeof prepareHeldReminderRevisionOwned = (input) =>
  prepareHeldReminderRevisionOwned(input);
/** A malformed canonical instruction edit is an accountable owner refusal. */
export const reminderRevisionRefusal: typeof reminderRevisionRefusalOwned = (input) =>
  reminderRevisionRefusalOwned(input);

/** Observe one User's reminder instructions under current processing Consent; grant and storage details stay private. */
export const findReminderSchedule = (
  input: Readonly<{ db: D1Database; userId: UserId }>
): Effect.Effect<Option.Option<ReminderSchedule>, InsightUnavailable> =>
  reminder.findSchedule(input).pipe(
    Effect.map(
      Option.map((schedule) => ({
        id: schedule.id,
        version: schedule.version,
        enabled: schedule.enabled,
        cadence: schedule.cadence,
        timing: schedule.timing,
        timeZone: schedule.timeZone,
        serviceMarket: schedule.serviceMarket,
        locale: schedule.locale,
        nextScheduledAt: schedule.nextScheduledAt,
      }))
    )
  );

const prepareCategoryStanding = (
  input: ProactivityConsentContext,
  decision: PreparedProactivityConsentDecision
): Effect.Effect<ReadonlyArray<D1PreparedStatement>, InsightUnavailable> =>
  Effect.gen(function* () {
    const statements: D1PreparedStatement[] = [];
    if (input.kind === "manual-entry-reminder") {
      if (decision.decision === "accept" || decision.decision === "continue") {
        statements.push(
          ...(yield* reminder.prepareActivation({ ...input, grantId: decision.grantId }))
        );
      } else statements.push(reminder.prepareDisable(input));
    }
    if (input.kind === "new-recurring-series") {
      if (decision.decision === "accept" || decision.decision === "continue") {
        statements.push(
          ...(yield* recurringStanding.prepareActivation({ ...input, grantId: decision.grantId }))
        );
      } else statements.push(recurringStanding.prepareDisable(input));
    }
    return statements;
  });
/** Commit an exact authenticated category choice with reminder activation/disablement in one User-coordinated D1 unit. Legal standing is never inferred from a canonical/model call. */
export const recordProactivityDecision = (
  input: ProactivityConsentContext & Readonly<{ choice: string; decisionMessageId: string }>
): Effect.Effect<boolean, InsightUnavailable> =>
  Effect.gen(function* () {
    const prepared = yield* prepareProactivityConsentDecision(input);
    if (Option.isNone(prepared)) return false;
    const decision = prepared.value;
    const statements = [...decision.statements];
    if (input.kind === "budget-threshold" && decision.decision === "accept") {
      if (!(yield* evaluateBudgetAlerts(input))) return false;
      statements.unshift(prepareBudgetOptInFence(input));
    }
    statements.push(...(yield* prepareCategoryStanding(input, decision)));
    yield* Effect.tryPromise(() => input.db.batch(statements));
    return true;
  }).pipe(Effect.mapError(() => new InsightUnavailable()));

/** Explicit native WhatsApp choice atomically changes exact recurring Consent and standing; other categories are refused. */
export const recordRecurringDigestDecision = (
  input: ProactivityConsentContext & Readonly<{ choice: string; decisionMessageId: string }>
): Effect.Effect<boolean, InsightUnavailable> =>
  input.kind === "new-recurring-series" ? recordProactivityDecision(input) : Effect.succeed(false);

/** Advance bounded confirmation consumption and freeze one complete closed captured day under the existing User coordinator. */
export const advanceRecurringDigest = (
  input: Readonly<{ db: D1Database; userId: UserId; now: DateTime.Utc }>
): Effect.Effect<RecurringDigestAdvanceResult, InsightUnavailable> =>
  recurringGeneration.advance(input);

/** Read the complete immutable report for this explicit User; expiry of its send never removes historical facts. */
export const findRecurringDigestReport = (
  input: Readonly<{ db: D1Database; userId: UserId; id: InsightEventId }>
): Effect.Effect<Option.Option<RecurringDigestReport>, InsightUnavailable> =>
  recurringGeneration.findReport(input);

/** Prepare a complete reminder instruction edit under the caller's User coordination. Compose these revision/grant/Consent guards with canonical credential authority and Audit in the caller's atomic unit; this operation never grants opt-in. */
export const prepareReminderRevision = (
  input: Readonly<{
    db: D1Database;
    userId: UserId;
    input: ReminderScheduleEdit;
    now: DateTime.Utc;
  }>
): Effect.Effect<
  ReadonlyArray<D1PreparedStatement>,
  InsightUnavailable | ReminderRevisionConflict
> => reminder.prepareRevision(input);

/** Materialize only the latest still-fresh reminder with an exact enabled instruction/grant guard. Event, immutable deadline, outbox and advancement commit together; replay cannot create a backlog. */
export const materializeReminder = (
  input: Readonly<{ db: D1Database; userId: UserId; id: ScheduleId; now: DateTime.Utc }>
): Effect.Effect<ReminderMaterialization, InsightUnavailable> => reminder.materialize(input);

/** Reject invalid governor knobs before production execution or delivery settlement. */
export const readWeeklyThresholds: typeof weeklyThresholds = (input) => weeklyThresholds(input);

/** Authenticated explicit command creates a bounded, replay-safe request; no Consent is inferred. */
export const requestWeeklySummaryConsent: typeof requestQuestion = (input) =>
  requestQuestion(input);

/** Observe same-User governor standing under current processing Consent. */
export const findWeeklyGovernor: typeof findGovernor = (input) => findGovernor(input);
/** Compose an authenticated category-correlated reply with its admitted User request. */
export const prepareWeeklyGovernorReply: typeof prepareReply = (input) => prepareReply(input);
/** Question delivery never increments scheduled-message counters. */
export const prepareWeeklyQuestionDelivery: typeof prepareQuestionDelivered = (input) =>
  prepareQuestionDelivered(input);
/** Reserve the pause mention for an admitted User-initiated session only. */
export const prepareWeeklyPauseNotice: typeof prepareNotice = (input) => prepareNotice(input);
/** Fixed copy, not model inference, accompanies this exact admitted Turn's answer. */
export const readWeeklyPauseNotice: typeof readNotice = (input) => readNotice(input);
/** Consume the mention only with authoritative visible delivery of its exact prefix. */
export const prepareWeeklyPauseNoticeCompletion: typeof prepareNoticeCompletion = (input) =>
  prepareNoticeCompletion(input);

/** Compose actual verified channel evidence, forward-only attention and outbox settlement with the Agent's exact Transcript copy in one caller-coordinated D1 batch. */
export const prepareWeeklyDeliverySettlement: typeof prepareWeeklyDeliverySettlementOwned = (
  input
) => prepareWeeklyDeliverySettlementOwned(input);

/** Materialize only the latest relevant cutoff under the existing User coordinator and caller-owned security admission. Complete revision guards commit financial facts, occurrence, report, outbox and schedule advance atomically; unavailable facts never become no activity. */
export const materializeWeeklySummary = (
  input: Readonly<{ db: D1Database; userId: UserId; id: ScheduleId; now: DateTime.Utc }>
): Effect.Effect<WeeklyMaterialization, InsightUnavailable> => materialize(input);
/** Recheck the enabled schedule and captured grant in the channel owner's irreversible claim action. */
export const weeklyReportDeliveryQuery: typeof weeklyReportDeliveryQueryOwned = (input) =>
  weeklyReportDeliveryQueryOwned(input);

/** Read the complete immutable same-User report under current processing Consent; this read cannot authorize provider egress. */
export const findWeeklySummaryReport = (
  input: Readonly<{ db: D1Database; userId: UserId; id: InsightEventId }>
): Effect.Effect<Option.Option<WeeklySummaryReport>, InsightUnavailable> => findReport(input);

/** Apply an authenticated exchange-qualified WhatsApp decision and schedule activation/revocation in one atomic User-coordinated unit. This is not a canonical or model-callable Consent operation. */
export const recordWeeklySummaryDecision = (
  input: WeeklyConsentContext & Readonly<{ choice: string; decisionMessageId: string }>
): Effect.Effect<boolean, InsightUnavailable> =>
  Effect.gen(function* () {
    const decision = yield* prepareWeeklyConsentDecision(input).pipe(
      Effect.mapError(() => new InsightUnavailable())
    );
    if (Option.isNone(decision)) return false;
    const actions = [...decision.value.statements, prepareReset(input)];
    if (decision.value.decision === "accept" || decision.value.decision === "continue") {
      if (Option.isNone(decision.value.grantId)) return yield* new InsightUnavailable();
      actions.push(
        ...(yield* prepareScheduleEnable({ ...input, grantId: decision.value.grantId.value }))
      );
    }
    if (decision.value.decision === "revoke" || decision.value.decision === "decline") {
      actions.push(prepareScheduleDisable(input));
    }
    yield* Effect.tryPromise({
      try: () => input.db.batch(actions),
      catch: () => new InsightUnavailable(),
    });
    return true;
  });

/** Current same-User instruction for authorized processing under existing User coordination; absence grants no authority. */
export const findWeeklySchedule = (
  input: Readonly<{ db: D1Database; userId: UserId }>
): Effect.Effect<Option.Option<WeeklyScheduleSnapshot>, InsightUnavailable> => findSchedule(input);
/** Bounded identities only. Re-read under User coordination; discovery grants no access or send permission. */
export const discoverDueWeeklySchedules = (
  input: Readonly<{ db: D1Database; now: DateTime.Utc }>
): Effect.Effect<ReadonlyArray<DueWeeklySchedule>, InsightUnavailable> => discoverSchedules(input);
/** Rotate recovery discovery fairly even when a due User has withdrawn processing authority; this updates operational metadata only. */
export const noteWeeklyScheduleEvaluation = (
  input: Readonly<{ db: D1Database; userId: UserId; id: ScheduleId; now: DateTime.Utc }>
): Effect.Effect<void, InsightUnavailable> => noteScheduleEvaluation(input);
/** Guard an owner statement ending at its WHERE condition against current captured schedule and exact live Consent grant. */
export const prepareWeeklyOccurrenceGuard = (input: WeeklyOccurrenceGuard): D1PreparedStatement =>
  occurrenceGuard(input);
/** Commit after the occurrence/report/outbox writes in the same batch; stale, disabled, revoked or replayed work aborts the entire unit. */
export const prepareWeeklyScheduleAdvance = (
  input: WeeklyScheduleAdvance
): ReadonlyArray<D1PreparedStatement> => scheduleAdvance(input);

/**
 * Read one User's authoritative occurrence inside that User's coordination boundary. The caller
 * establishes the purpose and live authority; an occurrence identity grants no access by itself.
 * Retained schedule context and exact Currency-separated Money never follow later preferences.
 */
export const findInsight = (
  input: Omit<Parameters<typeof find>[0], "userId"> & Readonly<{ userId: UserId }>
): ReturnType<typeof find> => find(input);

/**
 * Retain one scheduled occurrence for an explicit User under the existing User coordinator.
 * Supply validated historical schedule context and Money groups from published owner projections,
 * never another owner's rows. Replay returns the original occurrence without rewriting its facts
 * or lifecycle. The caller establishes current processing authority before generation.
 */
export const generateInsight = (
  input: Omit<Parameters<typeof generate>[0], "userId"> & Readonly<{ userId: UserId }>
): ReturnType<typeof generate> => generate(input);

/**
 * Discover at most 64 pending due identities, oldest scheduled instant then identity first.
 * These are coordination hints only: enter each User's existing coordinator, recheck current
 * authority and read its authoritative occurrence before processing or delivery.
 */
export const discoverDueInsights: typeof discover = (input) => discover(input);

/**
 * Read one bounded canonical pending page under the caller's live credential and explicit User.
 * Cursor ordering and canonical delivery share the same authoritative occurrence records.
 */
export const listPendingInsights: typeof list = (input) => list(input);

/**
 * Prepare one forward-only lifecycle movement, actual send evidence and metadata-only Audit for
 * the shared one-User canonical commit. The caller owns the atomic unit and coordination; live
 * credential, Consent and current lifecycle are rechecked at commit, so stale work cannot regress.
 * Preparing or recording delivery does not send anything to an external provider.
 */
export const prepareInsightTransition: typeof prepare = (input) => prepare(input);

/** Present and record a closed lifecycle refusal under the same live caller's authority. */
export const insightRefusal: typeof refuse = (input) => refuse(input);

/** Read the same User's immutable send evidence without treating provider identity as authority. */
export const findInsightAttempt = (
  input: Omit<Parameters<typeof findAttempt>[0], "userId"> & Readonly<{ userId: UserId }>
): ReturnType<typeof findAttempt> => findAttempt(input);

/** Canonical complete report read rechecks the caller's live read authority and records accountability in the same commit. */
export const readCanonicalRecurringDigestReport: typeof readCanonicalDigestOwned = (input) =>
  readCanonicalDigestOwned(input);
/** Held hosted report access retains the same User and original admitted Turn authority. */
export const readHeldRecurringDigestReport: typeof readHeldDigestOwned = (input) =>
  readHeldDigestOwned(input);

/** Offer the first retained discovery in an authenticated foreground WhatsApp interaction, including permanently suppressed discoveries. */
export const requestRecurringDigestOffer = (
  input: ProactivityConsentContext & Readonly<{ messageId: string }>
): Effect.Effect<void, InsightUnavailable> => requestDiscoveryOffer(input);
