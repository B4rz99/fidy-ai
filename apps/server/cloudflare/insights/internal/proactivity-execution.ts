import { summariesDue } from "./cadence";
import { settleDeliveryWork } from "./proactivity-delivery-work";
import { continueQueuedDelivery, queuedDeliveryQuery } from "./queued-delivery";
import { advance as advanceRecurringDigest } from "./recurring-generation";
import { findRecurringDiscovery } from "../../recurring/operations";
import { DateTime, Effect, Option } from "effect";
import { type UserId } from "../../../src/core/identity/contract";
import {
  InsightUnavailable,
  type ProactivityActivity,
  type ProactivityActivityResult,
} from "../contract";
import { findSchedule, materialize } from "./reminder-schedule";
import { admitWeeklyResource } from "./weekly-admission";
import { deliveryQuery, findQueuedReport } from "./proactivity-reports";
import {
  findQueuedInsightRecipient,
  recordProactivitySend,
  stageProactivityMessage,
  startProactivitySend,
} from "../../whatsapp/operations";
import type { ProactivityChannelClaim, ProactivityChannelScope } from "../../whatsapp/contract";
import type { ProactivityTemplateSender } from "../../../src/shell/channels/whatsapp/contract";
import { sendEvidence } from "./weekly-execution";
import { generateReminderQuestion } from "./reminder-question";
import { generateOffers } from "./proactivity-offers";
import { generateBudgetAlerts } from "./budget-generation";
import { readConsentStatus } from "../../consent/operations";
import { evaluateBudgetAlerts } from "../../budgets/operations";

/** Category generation runs inside the existing User coordinator, without provider effects or financial backlog replay. */
export const generateProactivity = (
  input: Readonly<{
    db: D1Database;
    userId: UserId;
    now: DateTime.Utc;
    work: Extract<ProactivityActivity, { kind: "proactivity-generate" }>;
  }>
): Effect.Effect<ProactivityActivityResult, InsightUnavailable> =>
  Effect.gen(function* () {
    if (input.userId !== input.work.userId) return yield* new InsightUnavailable();
    if ((yield* readConsentStatus(input)) !== "Granted") return { _tag: "Done" } as const;
    yield* admitWeeklyResource({ ...input, phase: "generation" });
    yield* evaluateBudgetAlerts(input);
    yield* generateBudgetAlerts(input);
    yield* generateOffers(input);
    yield* generateReminderQuestion(input);
    const schedule = yield* findSchedule(input);
    if (Option.isSome(schedule)) yield* materialize({ ...input, id: schedule.value.id });
    if (summariesDue(input.now) && Option.isSome(yield* findRecurringDiscovery(input))) {
      yield* advanceRecurringDigest(input);
    }
    return { _tag: "Done" } as const;
  }).pipe(Effect.mapError(() => new InsightUnavailable()));

const finishSend = (
  input: ProactivityChannelScope &
    Readonly<{
      work: Extract<ProactivityActivity, { kind: "proactivity-delivery" }>;
      sender: ProactivityTemplateSender;
    }>,
  claim: ProactivityChannelClaim
): Effect.Effect<ProactivityActivityResult, InsightUnavailable> =>
  Effect.gen(function* () {
    if (claim._tag === "Ready") {
      const sent = sendEvidence(yield* Effect.exit(input.sender.send(claim.request)));
      yield* recordProactivitySend({
        ...input,
        correlationToken: claim.correlationToken,
        outcome: sent.certainty,
        providerMessageId: sent.providerMessageId,
      });
      yield* settleDeliveryWork({ ...input, state: "started" });
    }
    if (claim._tag === "Expired") yield* settleDeliveryWork({ ...input, state: "expired" });
    return { _tag: "Done" } as const;
  }).pipe(Effect.mapError(() => new InsightUnavailable()));

/** Frozen report content is claimed once under current purpose, recipient and resource authority. */
export const deliverProactivity = (
  input: Readonly<{
    db: D1Database;
    userId: UserId;
    now: DateTime.Utc;
    work: Extract<ProactivityActivity, { kind: "proactivity-delivery" }>;
    sender: ProactivityTemplateSender;
  }>
): Effect.Effect<ProactivityActivityResult, InsightUnavailable> =>
  Effect.gen(function* () {
    if (input.userId !== input.work.userId) return yield* new InsightUnavailable();
    if (!(yield* continueQueuedDelivery({ ...input, now: input.now.epochMilliseconds }))) {
      return { _tag: "Done" } as const;
    }
    const queued = queuedDeliveryQuery({ ...input, now: input.now.epochMilliseconds });
    const report = yield* findQueuedReport({ ...input, id: input.work.id, queued });
    const recipient = yield* findQueuedInsightRecipient({ ...input, queued });
    if (Option.isNone(report) || Option.isNone(recipient)) return yield* new InsightUnavailable();
    const frozen = report.value;
    if (Option.isNone(frozen.text)) return { _tag: "Done" } as const;
    const permission =
      frozen._tag === "GrantMessage"
        ? { role: frozen.role, grantId: frozen.grantId }
        : { role: frozen.role };
    const scope = {
      ...input,
      id: input.work.id,
      ...permission,
      queuedAdmission: Option.some(queued),
      guard: deliveryQuery({ userId: input.userId, id: input.work.id }),
    };
    yield* stageProactivityMessage({
      ...scope,
      recipient: recipient.value,
      text: frozen.text.value,
      scheduledAt: frozen.scheduledAt,
      expiresAt: frozen.expiresAt,
      timeZone: frozen.timeZone,
      sender: input.sender,
    });
    yield* admitWeeklyResource({ ...input, phase: "send" });
    const sendAt = yield* DateTime.now;
    const claim = yield* startProactivitySend({
      ...scope,
      now: sendAt,
      queuedAdmission: Option.some(
        queuedDeliveryQuery({ ...input, now: sendAt.epochMilliseconds })
      ),
    });
    if (claim._tag === "Deferred") {
      return {
        _tag: "Deferred",
        nextEligibleAtMs: claim.nextEligibleAt.epochMilliseconds,
      } as const;
    }
    return yield* finishSend(scope, claim);
  }).pipe(
    Effect.mapError(() => new InsightUnavailable()),
    Effect.withSpan("insights.proactivity.delivery")
  );
