import { nativePendingWork } from "./internal/native-work-observation";
import {
  acknowledgePauseNotice,
  bindPauseNotice,
  includePauseNotice,
} from "./internal/native-pause-notice";
import { readLocalReport } from "./internal/recurring-report";
import { claimDisclosure, retainedDisclosure } from "./internal/local-disclosure";
import { claimPurpose, reconcileReceipt } from "./internal/reminder-claim";
import {
  pendingInsights,
  prepareSchedule,
  prepareTransition,
  readSchedule,
} from "./internal/local-insights";
import { readAssociatedProactiveTranscript } from "../agent/operations";
import { type PauseNoticeService, ProactivityWorkObservations } from "./contract";
import {
  PendingDeliveryObservations,
  prepareProactivityWorkObservation,
} from "./internal/operational-observation";
import { proactivityWorkflowId } from "./internal/proactivity-workflow";
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
import { prepareBudgetThresholdOptIn } from "../budgets/operations";
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
import { type DateTime, Effect, Option, Schema } from "effect";
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
  type WeeklyScheduleSnapshot,
  type WeeklySummaryReport,
} from "./contract";
import {
  discoverSchedules,
  findSchedule,
  noteScheduleEvaluation,
  prepareScheduleDisable,
  prepareScheduleEnable,
} from "./internal/weekly-schedule";
import {
  findReport,
  runGeneration,
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

import {
  prepareTranscriptAssociations,
  transcriptAssociationQuery,
} from "./internal/transcript-associations";

export const controlManualReminders: typeof controlReminderOwned = (input) =>
  controlReminderOwned(input);

export const findReminderGovernor: typeof findReminderGovernorOwned = (input) =>
  findReminderGovernorOwned(input);

export const prepareReminderDelivery: typeof prepareReminderDeliveryOwned = (input) =>
  prepareReminderDeliveryOwned(input);

export const prepareReminderReply: typeof prepareReminderReplyOwned = (input) =>
  prepareReminderReplyOwned(input);

export const prepareReminderPauseNotice: typeof prepareReminderNoticeOwned = (input) =>
  prepareReminderNoticeOwned(input);

export const readReminderPauseNotice: typeof readReminderNoticeOwned = (input) =>
  readReminderNoticeOwned(input);

export const prepareReminderPauseNoticeCompletion: typeof prepareReminderNoticeCompletionOwned = (
  input
) => prepareReminderNoticeCompletionOwned(input);

export const requestProactivityConsent: typeof requestOffer = (input) => requestOffer(input);

export const findProactivityReport: typeof findProactivityReportOwned = (input) =>
  findProactivityReportOwned(input);

export const prepareProactivityDeliverySettlement: typeof prepareSettlement = (input) =>
  prepareSettlement(input);

export const proactivityTranscriptOccurrenceQuery: typeof transcriptOccurrenceQuery = (input) =>
  transcriptOccurrenceQuery(input);

export const proactivityTranscriptLinksQuery: typeof transcriptLinksQuery = (input) =>
  transcriptLinksQuery(input);

export const readCanonicalReminderSchedule: typeof readCanonicalReminderScheduleOwned = (input) =>
  readCanonicalReminderScheduleOwned(input);

export const prepareCanonicalReminderRevision: typeof prepareCanonicalReminderRevisionOwned = (
  input
) => prepareCanonicalReminderRevisionOwned(input);

export const readHeldReminderSchedule: typeof readHeldReminderScheduleOwned = (input) =>
  readHeldReminderScheduleOwned(input);

export const prepareHeldReminderRevision: typeof prepareHeldReminderRevisionOwned = (input) =>
  prepareHeldReminderRevisionOwned(input);

export const reminderRevisionRefusal: typeof reminderRevisionRefusalOwned = (input) =>
  reminderRevisionRefusalOwned(input);

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

export const recordProactivityDecision = (
  input: ProactivityConsentContext & Readonly<{ choice: string; decisionMessageId: string }>
): Effect.Effect<boolean, InsightUnavailable> =>
  Effect.gen(function* () {
    const prepared = yield* prepareProactivityConsentDecision(input);
    if (Option.isNone(prepared)) return false;
    const decision = prepared.value;
    const statements = [...decision.statements];
    if (input.kind === "budget-threshold" && decision.decision === "accept") {
      const fence = yield* prepareBudgetThresholdOptIn(input);
      if (Option.isNone(fence)) return false;
      statements.unshift(fence.value);
    }
    statements.push(...(yield* prepareCategoryStanding(input, decision)));
    yield* Effect.tryPromise(() => input.db.batch(statements));
    return true;
  }).pipe(Effect.mapError(() => new InsightUnavailable()));

export const recordRecurringDigestDecision = (
  input: ProactivityConsentContext & Readonly<{ choice: string; decisionMessageId: string }>
): Effect.Effect<boolean, InsightUnavailable> =>
  input.kind === "new-recurring-series" ? recordProactivityDecision(input) : Effect.succeed(false);

export const advanceRecurringDigest = (
  input: Readonly<{ db: D1Database; userId: UserId; now: DateTime.Utc }>
): Effect.Effect<RecurringDigestAdvanceResult, InsightUnavailable> =>
  recurringGeneration.advance(input);

export const findRecurringDigestReport = (
  input: Readonly<{ db: D1Database; userId: UserId; id: InsightEventId }>
): Effect.Effect<Option.Option<RecurringDigestReport>, InsightUnavailable> =>
  recurringGeneration.findReport(input);

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

export const materializeReminder = (
  input: Readonly<{ db: D1Database; userId: UserId; now: DateTime.Utc }>
): Effect.Effect<ReminderMaterialization, InsightUnavailable> => reminder.advanceReminderDue(input);

export const readWeeklyThresholds: typeof weeklyThresholds = (input) => weeklyThresholds(input);

export const requestWeeklySummaryConsent: typeof requestQuestion = (input) =>
  requestQuestion(input);

export const findWeeklyGovernor: typeof findGovernor = (input) => findGovernor(input);

export const prepareWeeklyGovernorReply: typeof prepareReply = (input) => prepareReply(input);

export const prepareWeeklyQuestionDelivery: typeof prepareQuestionDelivered = (input) =>
  prepareQuestionDelivered(input);

export const prepareWeeklyPauseNotice: typeof prepareNotice = (input) => prepareNotice(input);

export const readWeeklyPauseNotice: typeof readNotice = (input) => readNotice(input);

export const prepareWeeklyPauseNoticeCompletion: typeof prepareNoticeCompletion = (input) =>
  prepareNoticeCompletion(input);

export const prepareWeeklyDeliverySettlement: typeof prepareWeeklyDeliverySettlementOwned = (
  input
) => prepareWeeklyDeliverySettlementOwned(input);

export const runWeeklyGeneration = (
  input: Readonly<{ db: D1Database; userId: UserId; id: ScheduleId; now: DateTime.Utc }>
): Effect.Effect<WeeklyMaterialization, InsightUnavailable> => runGeneration(input);

export const weeklyReportDeliveryQuery: typeof weeklyReportDeliveryQueryOwned = (input) =>
  weeklyReportDeliveryQueryOwned(input);

export const findWeeklySummaryReport = (
  input: Readonly<{ db: D1Database; userId: UserId; id: InsightEventId }>
): Effect.Effect<Option.Option<WeeklySummaryReport>, InsightUnavailable> => findReport(input);

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

export const findWeeklySchedule = (
  input: Readonly<{ db: D1Database; userId: UserId }>
): Effect.Effect<Option.Option<WeeklyScheduleSnapshot>, InsightUnavailable> => findSchedule(input);

export const discoverDueWeeklySchedules = (
  input: Readonly<{ db: D1Database; now: DateTime.Utc }>
): Effect.Effect<ReadonlyArray<DueWeeklySchedule>, InsightUnavailable> => discoverSchedules(input);

export const noteWeeklyScheduleEvaluation = (
  input: Readonly<{ db: D1Database; userId: UserId; id: ScheduleId; now: DateTime.Utc }>
): Effect.Effect<void, InsightUnavailable> => noteScheduleEvaluation(input);

export const findInsight = (
  input: Omit<Parameters<typeof find>[0], "userId"> & Readonly<{ userId: UserId }>
): ReturnType<typeof find> => find(input);

export const generateInsight = (
  input: Omit<Parameters<typeof generate>[0], "userId"> & Readonly<{ userId: UserId }>
): ReturnType<typeof generate> => generate(input);

export const discoverDueInsights: typeof discover = (input) => discover(input);

export const listPendingInsights: typeof list = (input) => list(input);

export const prepareInsightTransition: typeof prepare = (input) => prepare(input);

export const insightRefusal: typeof refuse = (input) => refuse(input);

export const findInsightAttempt = (
  input: Omit<Parameters<typeof findAttempt>[0], "userId"> & Readonly<{ userId: UserId }>
): ReturnType<typeof findAttempt> => findAttempt(input);

export const readCanonicalRecurringDigestReport: typeof readCanonicalDigestOwned = (input) =>
  readCanonicalDigestOwned(input);

export const readHeldRecurringDigestReport: typeof readHeldDigestOwned = (input) =>
  readHeldDigestOwned(input);

export const requestRecurringDigestOffer = (
  input: ProactivityConsentContext & Readonly<{ messageId: string }>
): Effect.Effect<void, InsightUnavailable> => requestDiscoveryOffer(input);

export const observeProactivityWork = (
  input: Readonly<{ db: D1Database; weeklyEnabled: boolean; proactivityEnabled: boolean }>
): Effect.Effect<ProactivityWorkObservations, InsightUnavailable> =>
  Effect.gen(function* () {
    const result = yield* Effect.tryPromise(() => prepareProactivityWorkObservation(input).all());
    const rows = yield* Schema.decodeUnknownEffect(PendingDeliveryObservations)(result.results);
    const observations = yield* Effect.forEach(rows, (row) =>
      proactivityWorkflowId(row).pipe(
        Effect.map((id) => ({ id, created: row.created, deadline: row.deadline }))
      )
    );
    return yield* Schema.decodeEffect(Schema.toType(ProactivityWorkObservations))(observations);
  }).pipe(Effect.mapError(() => new InsightUnavailable()));

export const prepareInsightTranscriptAssociations: typeof prepareTranscriptAssociations = (input) =>
  prepareTranscriptAssociations(input);

export const readProactiveTranscript = (
  input: Readonly<{ db: D1Database; userId: UserId; insightEventId: InsightEventId; now: number }>
): ReturnType<typeof readAssociatedProactiveTranscript> =>
  readAssociatedProactiveTranscript({ ...input, association: transcriptAssociationQuery(input) });

export const prepareLocalInsight: typeof prepareTransition = (...input) =>
  prepareTransition(...input);
export const prepareLocalReminder: typeof prepareSchedule = (...input) => prepareSchedule(...input);
export const readLocalReminder: typeof readSchedule = (user) => readSchedule(user);

export const claimLocalReminderPurpose: typeof claimPurpose = (...args) => claimPurpose(...args);
export const reconcileLocalReminder: typeof reconcileReceipt = (...args) =>
  reconcileReceipt(...args);

export const claimLocalDisclosure: typeof claimDisclosure = (...args) => claimDisclosure(...args);
export const isRetainedDisclosure: typeof retainedDisclosure = (...args) =>
  retainedDisclosure(...args);

export const readLocalPendingInsights: typeof pendingInsights = (...args) =>
  pendingInsights(...args);

export const readLocalDigestReport: typeof readLocalReport = (input) => readLocalReport(input);

export const nativePauseNotice: PauseNoticeService = {
  bind: (...args: Parameters<typeof bindPauseNotice>) =>
    bindPauseNotice(...args).pipe(Effect.mapError(() => new InsightUnavailable())),
  include: (...args: Parameters<typeof includePauseNotice>) =>
    includePauseNotice(...args).pipe(Effect.mapError(() => new InsightUnavailable())),
  acknowledge: (...args: Parameters<typeof acknowledgePauseNotice>) =>
    acknowledgePauseNotice(...args).pipe(Effect.mapError(() => new InsightUnavailable())),
};

export const localProactivityObservations: typeof nativePendingWork = (flags) =>
  nativePendingWork(flags);
