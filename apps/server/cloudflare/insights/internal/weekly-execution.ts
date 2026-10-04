import { Cause, DateTime, Effect, Exit, Option, Schema } from "effect";
import { type UserId } from "../../../src/core/identity/contract";
import { type ConsentRecordId } from "../../../src/core/consent/contract";
import { readUserContext } from "../../identity/user-context/operations";
import { admitWeeklyResource } from "./weekly-admission";
import {
  type InsightDeliveryDecision,
  type ProactivityThresholds,
} from "../../../src/core/insights/contract";
import { type IanaTimeZone } from "../../../src/core/_shared/context";
import { decideInsightDelivery } from "../../../src/core/insights/operations";
import {
  type InsightTemplateSender,
  type InsightTemplateUnavailable,
  type WeeklyQuestionSender,
  type WhatsAppProviderMessageId,
  type WhatsAppSendFailed,
  type WhatsAppSentMessage,
} from "../../../src/shell/channels/whatsapp/contract";
import { type InsightWhatsAppSendResult } from "../../whatsapp/contract";
import { createWeeklyGovernorConsentOffer, findWeeklyConsentGrant } from "../../consent/operations";
import {
  findInsightRecipient,
  recordInsightSend,
  recordWeeklyQuestionSend,
  stageInsightDelivery,
  stageWeeklyQuestion,
  startInsightSend,
  startWeeklyQuestion,
} from "../../whatsapp/operations";
import {
  InsightUnavailable,
  type WeeklyActivity,
  type WeeklyActivityResult,
  type WeeklyEnvironment,
  WeeklyThresholdConfiguration,
} from "../contract";
import { findReport, materialize, weeklyReportDeliveryQuery } from "./weekly-generation";
import { findInsight } from "./insight-store";
import { findQuestionOrigin, questionIntentQuery, settleDeliveryWork } from "./weekly-work";

export type WeeklySenders = Readonly<{
  summary: InsightTemplateSender;
  question: WeeklyQuestionSender;
}>;
type Execution = Readonly<{
  db: D1Database;
  userId: UserId;
  work: Exclude<WeeklyActivity, { kind: "weekly-recover" }>;
  now: DateTime.Utc;
  senders: WeeklySenders;
}>;
export const weeklyThresholds = (
  environment: WeeklyEnvironment
): Effect.Effect<ProactivityThresholds, InsightUnavailable> =>
  Schema.decodeEffect(WeeklyThresholdConfiguration)({
    askAfter: environment.PROACTIVITY_ASK_AFTER ?? "4",
    pauseAfter: environment.PROACTIVITY_PAUSE_AFTER ?? "2",
  }).pipe(Effect.mapError(() => new InsightUnavailable()));

type SendEvidence = Readonly<{
  certainty: "accepted" | "ambiguous" | "rejected";
  providerMessageId: Option.Option<WhatsAppProviderMessageId>;
}>;
const sendEvidence = (
  sent: Exit.Exit<WhatsAppSentMessage, InsightTemplateUnavailable | WhatsAppSendFailed>
): SendEvidence => {
  if (Exit.isSuccess(sent)) {
    return {
      certainty: "accepted" as const,
      providerMessageId: Option.some(sent.value.messageEvidence.providerMessageId),
    };
  }
  const certainty = Option.match(Cause.findErrorOption(sent.cause), {
    onNone: () => "ambiguous" as const,
    onSome: (failure) =>
      failure._tag === "WhatsAppSendFailed" ? failure.deliveryCertainty : ("rejected" as const),
  });
  return { certainty, providerMessageId: Option.none() };
};

const summaryOutcome = (sent: SendEvidence): InsightWhatsAppSendResult["outcome"] =>
  Option.isSome(sent.providerMessageId)
    ? { kind: "accepted", providerMessageId: sent.providerMessageId.value }
    : { kind: sent.certainty === "rejected" ? "rejected" : "ambiguous" };

const deliverSummary = (
  input: Execution & Readonly<{ work: Extract<WeeklyActivity, { kind: "weekly-summary" }> }>
): Effect.Effect<WeeklyActivityResult, InsightUnavailable> =>
  Effect.gen(function* () {
    const { db, userId, work, now, senders } = input;
    const report = yield* findReport({ db, userId, id: work.insightEventId });
    const occurrence = yield* findInsight({ db, userId, id: work.insightEventId });
    const recipient = yield* findInsightRecipient({ db, userId });
    if (Option.isNone(report) || Option.isNone(occurrence) || Option.isNone(recipient)) {
      return yield* new InsightUnavailable();
    }
    const guard = weeklyReportDeliveryQuery({ userId, insightEventId: work.insightEventId });
    const scope = {
      db,
      userId,
      insightEventId: work.insightEventId,
      grantId: report.value.consentGrantId,
      now,
      guard,
    };
    yield* stageInsightDelivery({
      ...scope,
      recipient: recipient.value,
      summary: report.value.presentation,
      scheduledAt: occurrence.value.scheduledAt,
      expiresAt: report.value.expiresAt,
      timeZone: occurrence.value.timeZone,
      sender: senders.summary,
    });
    yield* admitWeeklyResource({ db, userId, now, phase: "send" });
    const claim = yield* startInsightSend(scope);
    if (claim._tag === "Deferred") {
      return {
        _tag: "Deferred",
        nextEligibleAtMs: claim.nextEligibleAt.epochMilliseconds,
      } as const;
    }
    if (claim._tag === "Ready") {
      const sent = sendEvidence(yield* Effect.exit(senders.summary.send(claim.request)));
      yield* recordInsightSend({
        ...scope,
        correlationToken: claim.correlationToken,
        outcome: summaryOutcome(sent),
      });
    }
    yield* settleDeliveryWork({
      db,
      work,
      state: claim._tag === "Expired" ? "expired" : "started",
    });
    return { _tag: "Done" } as const;
  }).pipe(Effect.mapError(() => new InsightUnavailable()));

const questionTiming = (
  input: Readonly<{ db: D1Database; userId: UserId; now: DateTime.Utc; createdAt: DateTime.Utc }>
): Effect.Effect<
  Readonly<{ timeZone: IanaTimeZone; decision: InsightDeliveryDecision }>,
  InsightUnavailable
> =>
  Effect.gen(function* () {
    const context = yield* readUserContext({
      db: input.db,
      userId: input.userId,
      authority: Option.none(),
    });
    if (Option.isNone(context)) return yield* new InsightUnavailable();
    return {
      timeZone: context.value.timeZone,
      decision: decideInsightDelivery({
        now: input.now,
        scheduledAt: input.createdAt,
        expiresAt: DateTime.add(input.createdAt, { days: 1 }),
        timeZone: context.value.timeZone,
      }),
    };
  }).pipe(Effect.mapError(() => new InsightUnavailable()));

const questionRequest = (
  input: Readonly<{
    id: string;
    origin: "requested" | "proactive";
    createdAt: DateTime.Utc;
    rejectionOfferId: Option.Option<ConsentRecordId>;
  }>
): Parameters<typeof createWeeklyGovernorConsentOffer>[0]["request"] =>
  input.origin === "requested"
    ? {
        _tag: "GovernorQuestion",
        origin: "requested",
        sourceId: input.id,
        requestedAt: input.createdAt,
        rejectionOfferId: input.rejectionOfferId,
      }
    : { _tag: "GovernorQuestion", origin: "proactive", sourceId: input.id };

const finishQuestion = (
  input: Readonly<{
    db: D1Database;
    work: Extract<WeeklyActivity, { kind: "weekly-question" }>;
    state: "refused" | "expired";
  }>
): Effect.Effect<WeeklyActivityResult, InsightUnavailable> =>
  settleDeliveryWork(input).pipe(Effect.as({ _tag: "Done" } as const));
const deliverQuestion = (
  input: Execution & Readonly<{ work: Extract<WeeklyActivity, { kind: "weekly-question" }> }>
): Effect.Effect<WeeklyActivityResult, InsightUnavailable> =>
  Effect.gen(function* () {
    const { db, userId, work, now, senders } = input;
    const origin = yield* findQuestionOrigin({ db, work });
    if (Option.isNone(origin)) {
      return yield* finishQuestion({ db, work, state: "refused" });
    }
    if (
      DateTime.add(origin.value.createdAt, { days: 1 }).epochMilliseconds <= now.epochMilliseconds
    ) {
      return yield* finishQuestion({ db, work, state: "expired" });
    }
    const recipient = yield* findInsightRecipient({ db, userId });
    if (Option.isNone(recipient)) {
      return yield* finishQuestion({ db, work, state: "refused" });
    }
    const timing = yield* questionTiming({ db, userId, now, createdAt: origin.value.createdAt });
    if (timing.decision._tag === "Deferred") {
      return {
        _tag: "Deferred",
        nextEligibleAtMs: timing.decision.nextEligibleAt.epochMilliseconds,
      } as const;
    }
    if (timing.decision._tag === "Expired") {
      return yield* finishQuestion({ db, work, state: "expired" });
    }
    const guard = questionIntentQuery({ userId, id: work.id });
    const context = {
      db,
      userId,
      caller: {
        businessPortfolioId: recipient.value.portfolioId,
        businessScopedUserId: recipient.value.bsuid,
      },
      now,
    };
    const request = questionRequest({ id: work.id, ...origin.value });
    const offer = yield* createWeeklyGovernorConsentOffer({ ...context, request });
    if (Option.isNone(offer)) {
      return yield* finishQuestion({ db, work, state: "refused" });
    }
    const grant = yield* findWeeklyConsentGrant(context);
    yield* stageWeeklyQuestion({
      db,
      userId,
      id: work.id,
      now,
      guard,
      offer: offer.value,
      grantId: Option.map(grant, (record) => record.id),
      recipient: recipient.value,
      timeZone: timing.timeZone,
      sender: senders.question,
    });
    return yield* sendQuestionClaim(input);
  }).pipe(Effect.mapError(() => new InsightUnavailable()));

const sendQuestionClaim = (
  input: Execution & Readonly<{ work: Extract<WeeklyActivity, { kind: "weekly-question" }> }>
): Effect.Effect<WeeklyActivityResult, InsightUnavailable> =>
  Effect.gen(function* () {
    const { db, userId, work, now, senders } = input;
    const guard = questionIntentQuery({ userId, id: work.id });
    yield* admitWeeklyResource({ db, userId, now, phase: "send" });
    const claim = yield* startWeeklyQuestion({ db, userId, id: work.id, now, guard });
    if (claim._tag === "Deferred") return claim;
    if (claim._tag === "Ready") {
      const sent = sendEvidence(yield* Effect.exit(senders.question.send(claim.request)));
      yield* recordWeeklyQuestionSend({
        db,
        userId,
        id: work.id,
        outcome: sent.certainty,
        providerMessageId: sent.providerMessageId,
      });
    }
    yield* settleDeliveryWork({ db, work, state: "settled" });
    return { _tag: "Done" } as const;
  }).pipe(Effect.mapError(() => new InsightUnavailable()));

export const executeWeeklyActivity = (
  input: Execution
): Effect.Effect<WeeklyActivityResult, InsightUnavailable> =>
  Effect.gen(function* () {
    if (input.work.userId !== input.userId) return yield* new InsightUnavailable();
    switch (input.work.kind) {
      case "weekly-generate":
        yield* admitWeeklyResource({
          db: input.db,
          userId: input.userId,
          now: input.now,
          phase: "generation",
        });
        yield* materialize({ ...input, id: input.work.id });
        return { _tag: "Done" } as const;
      case "weekly-summary":
        return yield* deliverSummary({ ...input, work: input.work });
      case "weekly-question":
        return yield* deliverQuestion({ ...input, work: input.work });
    }
  }).pipe(Effect.withSpan("insights.weekly.execute"));
