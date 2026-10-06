import { DateTime, Effect, Option } from "effect";
import { InsightEventId } from "../../../src/core/insights/contract";
import { TranscriptText } from "../../../src/core/agent/contract";
import { IanaTimeZone } from "../../../src/core/_shared/context";
import { type UserId } from "../../../src/core/identity/contract";
import type { WeeklyConsentContext } from "../../consent/contract";
import {
  hasProactivityConsentChoiceReceipt,
  hasWeeklyConsentChoiceReceipt,
  prepareVerifiedProactivityDisclosure,
  readProactivityConsentChoiceKind,
  recordWeeklyConsentDisclosure,
} from "../../consent/operations";
import {
  controlManualReminders,
  prepareProactivityDeliverySettlement,
  prepareReminderDelivery,
  prepareReminderReply,
  prepareWeeklyDeliverySettlement,
  prepareWeeklyGovernorReply,
  prepareWeeklyQuestionDelivery,
  proactivityTranscriptLinksQuery,
  proactivityTranscriptOccurrenceQuery,
  readWeeklyThresholds,
  recordProactivityDecision,
  recordWeeklySummaryDecision,
  requestProactivityConsent,
  requestWeeklySummaryConsent,
} from "../../insights/operations";
import { type WhatsAppStatusAdmission, type WhatsAppTurnAdmission } from "../../whatsapp/contract";
import {
  findWeeklyQuestionUser,
  insightVerifiedDeliveryQuery,
  insightVerifiedTranscriptQuery,
  prepareInsightRecipient,
  prepareProactivityStatus,
  proactivityReminderReplyQuery,
  proactivityVerifiedDeliveryQuery,
  proactivityVerifiedTranscriptQuery,
  readWeeklyReplyChoice,
  reconcileInsightStatus,
  reconcileProactivityStatus,
  reconcileWeeklyQuestion,
  weeklyQuestionDeliveryQuery,
  weeklySummaryReplyQuery,
} from "../../whatsapp/operations";
import { type AgentEnvironment, AgentUnavailable } from "../contract";
import {
  prepareGroupedProactiveTranscript,
  prepareMessageTranscript,
  prepareProactiveTranscript,
} from "./proactive-transcript";

const accepted = 202;
const success = 200;
const refused = 422;
type Status = Readonly<{
  environment: AgentEnvironment;
  userId: UserId;
  status: WhatsAppStatusAdmission;
}>;

const reconcileQuestion = (input: Status): Effect.Effect<boolean, AgentUnavailable> =>
  Effect.gen(function* () {
    const { environment, userId, status } = input;
    const question = yield* reconcileWeeklyQuestion({ db: environment.DB, admission: status });
    if (Option.isSome(question)) {
      yield* recordWeeklyConsentDisclosure({
        db: environment.DB,
        userId,
        caller: question.value.caller,
        offerId: question.value.offerId,
        disclosureMessageId: question.value.providerMessageId,
        now: DateTime.makeUnsafe(status.receivedAtMs),
      });
      yield* Effect.tryPromise(() =>
        environment.DB.batch([
          prepareWeeklyQuestionDelivery({
            db: environment.DB,
            userId,
            proof: weeklyQuestionDeliveryQuery({ userId, id: question.value.id }),
          }),
        ])
      );
      return true;
    }
    const owner = yield* findWeeklyQuestionUser({
      db: environment.DB,
      correlationToken: status.correlationToken,
      businessPhoneNumberId: status.businessPhoneNumberId,
    });
    return Option.isSome(owner) && owner.value === userId;
  }).pipe(Effect.mapError(() => new AgentUnavailable()));

const prepareCategorySettlement = (
  input: Status,
  id: string
): ReadonlyArray<D1PreparedStatement> => {
  const { environment, userId, status } = input;
  const scope = { db: environment.DB, userId, id };
  const proof = proactivityVerifiedDeliveryQuery(scope);
  const transcript = proactivityVerifiedTranscriptQuery({ ...scope, now: status.receivedAtMs });
  return [
    prepareProactivityStatus({ db: environment.DB, admission: status }),
    prepareVerifiedProactivityDisclosure({ ...scope, proof }),
    ...prepareReminderDelivery({ ...scope, proof }),
    ...prepareProactivityDeliverySettlement({ ...scope, proof }),
    prepareMessageTranscript({ ...scope, now: status.receivedAtMs, proof: transcript }),
    ...prepareGroupedProactiveTranscript({
      links: proactivityTranscriptLinksQuery({ ...scope, proof }),
      db: environment.DB,
      userId,
      insightEventId: InsightEventId.make(id),
      now: status.receivedAtMs,
      proof: proactivityTranscriptOccurrenceQuery({ ...scope, proof: transcript }),
    }),
  ];
};

/** Signed status is rechecked against same-User claims; actual Channel proof composes settlement atomically. */
export const reconcileWeeklyChannel = (input: Status): Effect.Effect<boolean, AgentUnavailable> =>
  Effect.gen(function* () {
    const { environment, userId, status } = input;
    if (yield* reconcileQuestion(input)) return true;
    const category = yield* reconcileProactivityStatus({ db: environment.DB, admission: status });
    if (category._tag === "VerifiedDelivery") {
      yield* Effect.tryPromise(() =>
        environment.DB.batch([...prepareCategorySettlement(input, category.id)])
      );
      return true;
    }
    if (category._tag === "Recorded") return true;
    const proactive = yield* reconcileInsightStatus({ db: environment.DB, admission: status });
    if (proactive._tag === "VerifiedDelivery") {
      const scope = { db: environment.DB, userId, insightEventId: proactive.insightEventId };
      const thresholds = yield* readWeeklyThresholds(environment);
      yield* Effect.tryPromise(() =>
        environment.DB.batch([
          ...prepareWeeklyDeliverySettlement({
            ...scope,
            proof: insightVerifiedDeliveryQuery(scope),
            thresholds,
          }),
          ...prepareProactiveTranscript({
            ...scope,
            now: status.receivedAtMs,
            proof: insightVerifiedTranscriptQuery({ ...scope, now: status.receivedAtMs }),
          }),
        ])
      );
      return true;
    }
    return proactive._tag === "Recorded";
  }).pipe(Effect.mapError(() => new AgentUnavailable()));

/** Authenticated replies reset attention even when inference or Hosted Turn admission is unavailable. */
export const recordWeeklyReply = (
  input: Readonly<{ db: D1Database; proof: WhatsAppTurnAdmission }>
): Effect.Effect<void, AgentUnavailable> =>
  Effect.tryPromise(() =>
    input.db.batch([
      prepareReminderReply({
        db: input.db,
        userId: input.proof.userId,
        proof: proactivityReminderReplyQuery(input.proof),
      }),
      prepareWeeklyGovernorReply({
        db: input.db,
        userId: input.proof.userId,
        proof: weeklySummaryReplyQuery(input.proof),
      }),
    ])
  ).pipe(
    Effect.asVoid,
    Effect.mapError(() => new AgentUnavailable())
  );

const handleProactivityChoice = (
  input: Readonly<{ context: WeeklyConsentContext; choice: string; decisionMessageId: string }>
): Effect.Effect<Response, AgentUnavailable> =>
  Effect.gen(function* () {
    const kind = readProactivityConsentChoiceKind(input.choice);
    if (Option.isNone(kind)) return new Response(null, { status: refused });
    const decision = {
      ...input.context,
      kind: kind.value,
      choice: input.choice,
      decisionMessageId: input.decisionMessageId,
    };
    if (yield* hasProactivityConsentChoiceReceipt(decision)) {
      return new Response(null, { status: success });
    }
    const saved = yield* recordProactivityDecision(decision);
    return new Response(null, { status: saved ? success : refused });
  }).pipe(Effect.mapError(() => new AgentUnavailable()));

const handleWeeklyConsentChoice = (
  input: WeeklyConsentContext & Readonly<{ choice: string; decisionMessageId: string }>
): Effect.Effect<Response, AgentUnavailable> =>
  Effect.gen(function* () {
    if (yield* hasWeeklyConsentChoiceReceipt(input)) return new Response(null, { status: success });
    const saved = yield* recordWeeklySummaryDecision(input);
    return new Response(null, { status: saved ? success : refused });
  }).pipe(Effect.mapError(() => new AgentUnavailable()));

const handleCategoryCommand = (
  input: Readonly<{
    environment: AgentEnvironment;
    proof: WhatsAppTurnAdmission;
    now: number;
    context: WeeklyConsentContext;
  }>
): Effect.Effect<Option.Option<Response>, AgentUnavailable> =>
  Effect.gen(function* () {
    const { environment, proof, now, context } = input;
    const command =
      /^(?:activar|reactivar) (?:los )?(recordatorios|alertas de presupuesto)$/iu.exec(
        proof.text.trim()
      );
    if (command === null) return Option.none();
    yield* Effect.tryPromise(() =>
      environment.DB.batch([
        prepareInsightRecipient({
          db: environment.DB,
          userId: proof.userId,
          recipient: {
            portfolioId: proof.portfolioId,
            bsuid: proof.bsuid,
            businessPhoneNumberId: proof.businessPhoneNumberId,
          },
          receivedAtMs: now,
        }),
      ])
    );
    yield* requestProactivityConsent({
      ...context,
      kind:
        command[1]?.toLowerCase() === "recordatorios"
          ? "manual-entry-reminder"
          : "budget-threshold",
      messageId: proof.messageId,
    });
    return Option.some(new Response(null, { status: accepted }));
  }).pipe(Effect.mapError(() => new AgentUnavailable()));

/** Explicit commands and exact disclosure-qualified choices never become inferred Consent or invented Turns. */
export const handleWeeklyChoice = (
  input: Readonly<{ environment: AgentEnvironment; proof: WhatsAppTurnAdmission; now: number }>
): Effect.Effect<Option.Option<Response>, AgentUnavailable> =>
  Effect.gen(function* () {
    const { environment, proof, now } = input;
    const context = {
      db: environment.DB,
      userId: proof.userId,
      caller: { businessPortfolioId: proof.portfolioId, businessScopedUserId: proof.bsuid },
      now: DateTime.makeUnsafe(now),
      timeZone: IanaTimeZone.make("America/Bogota"),
    };
    const replyChoice = yield* readWeeklyReplyChoice({ db: environment.DB, proof, now });
    const choice = Option.getOrElse(replyChoice, () => proof.text);
    if (choice.startsWith("reminder:")) {
      const saved = yield* controlManualReminders({
        db: environment.DB,
        proof: { ...proof, text: TranscriptText.make(choice) },
        now,
      });
      return Option.some(new Response(null, { status: saved ? success : refused }));
    }
    if (choice.startsWith("proactivity:")) {
      return Option.some(
        yield* handleProactivityChoice({ context, choice, decisionMessageId: proof.messageId })
      );
    }
    if (choice.startsWith("weekly:")) {
      return Option.some(
        yield* handleWeeklyConsentChoice({ ...context, choice, decisionMessageId: proof.messageId })
      );
    }
    const categoryCommand = yield* handleCategoryCommand({ ...input, context });
    if (Option.isSome(categoryCommand)) return categoryCommand;
    if (!/^(?:activar|reactivar) (?:el )?resumen semanal$/iu.test(proof.text.trim())) {
      return Option.none();
    }
    yield* Effect.tryPromise(() =>
      environment.DB.batch([
        prepareInsightRecipient({
          db: environment.DB,
          userId: proof.userId,
          recipient: {
            portfolioId: proof.portfolioId,
            bsuid: proof.bsuid,
            businessPhoneNumberId: proof.businessPhoneNumberId,
          },
          receivedAtMs: now,
        }),
      ])
    );
    yield* requestWeeklySummaryConsent({ ...context, messageId: proof.messageId });
    return Option.some(new Response(null, { status: accepted }));
  }).pipe(Effect.mapError(() => new AgentUnavailable()));
