import { weeklyThresholds } from "./internal/weekly-execution";
import { requestQuestion } from "./internal/weekly-work";
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
import { type InsightEventId, type ScheduleId } from "../../src/core/insights/contract";
import { prepareWeeklyConsentDecision } from "../consent/operations";
import { type WeeklyConsentContext } from "../consent/contract";
import {
  type DueWeeklySchedule,
  InsightUnavailable,
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
