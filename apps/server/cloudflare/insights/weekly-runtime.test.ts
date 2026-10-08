import { afterAll, afterEach, expect, it, vi } from "vitest";
import { type Cause, DateTime, Effect, Option, Schema } from "effect";
import { InsightEventId } from "../../src/core/insights/contract";
import { categoryIds } from "../../src/core/categories/contract";
import {
  HostedDeliveryCorrelationToken,
  WhatsAppBusinessPhoneNumberId,
  WhatsAppProviderMessageId,
} from "../../src/shell/channels/whatsapp/contract";
import { createWeeklyGovernorConsentOffer, findWeeklyConsentGrant } from "../consent/operations";
import { prepareInsightRecipient } from "../whatsapp/operations";
import { WhatsAppStatusAdmission, WhatsAppTurnAdmission } from "../whatsapp/contract";
import {
  type ProactivityCoordinator,
  activateWeeklySummary,
  makeProactivityCoordinator,
  seedWeeklySummaryActivity,
  weeklySummaryDatabaseAt,
  weeklySummaryOtherUser,
  weeklySummaryTestCaller,
  weeklySummaryTestDatabases,
  weeklySummaryTestNow,
  weeklySummaryTestUser,
  withdrawWeeklyFixtureConsent,
} from "../weekly-summary.test-fixture";
import { ProactivityActivity, type ProactivityEnvironment } from "./contract";
import { findWeeklyGovernor, findWeeklySchedule } from "./operations";
import { admitWeeklyResource } from "./internal/weekly-admission";

const userId = weeklySummaryTestUser;
const phone = WhatsAppBusinessPhoneNumberId.make("123456789");
const recipient = {
  portfolioId: weeklySummaryTestCaller.businessPortfolioId,
  bsuid: weeklySummaryTestCaller.businessScopedUserId,
  businessPhoneNumberId: phone,
};
const template = {
  name: "fidy_weekly_summary",
  language: "es",
  approval: "approved",
  body: "Tu resumen semanal: {{1}} Consulta tus movimientos en Fidy.",
};
const questionTemplate = {
  name: "fidy_weekly_question",
  language: "es",
  approval: "approved",
  body: "Fidy: {{1}}",
};
const configuration = (db: D1Database): ProactivityEnvironment => ({
  DB: db,
  KAPSO_API_KEY: "provider-test-key",
  WEEKLY_SUMMARY_ENABLED: "enabled",
  WEEKLY_SUMMARY_TEMPLATE_JSON: JSON.stringify(template),
  WEEKLY_QUESTION_TEMPLATE_JSON: JSON.stringify(questionTemplate),
  PROACTIVITY_ASK_AFTER: "1",
  PROACTIVITY_PAUSE_AFTER: "1",
});
const makeCoordinator = (environment: ProactivityEnvironment): ProactivityCoordinator =>
  makeProactivityCoordinator({ environment, userId });
const activity = (
  coordinator: ProactivityCoordinator,
  work: ProactivityActivity
): Promise<Response> =>
  coordinator.fetch(
    new Request("https://coordinator/proactivity-work", {
      method: "POST",
      body: Schema.encodeSync(Schema.fromJsonString(ProactivityActivity))(work),
    })
  );
const proofRow = Schema.Struct({
  correlation_token: HostedDeliveryCorrelationToken,
  provider_message_id: WhatsAppProviderMessageId,
});
const delivered = (
  coordinator: ProactivityCoordinator,
  row: typeof proofRow.Type,
  now: number
): Promise<Response> =>
  coordinator.fetch(
    new Request("https://coordinator/hosted-turn/whatsapp/status", {
      method: "POST",
      body: Schema.encodeSync(Schema.fromJsonString(WhatsAppStatusAdmission))({
        userId,
        correlationToken: row.correlation_token,
        providerMessageId: row.provider_message_id,
        businessPhoneNumberId: phone,
        outcome: "delivered",
        occurredAtMs: now,
        receivedAtMs: now,
      }),
    })
  );
const inbound = (
  coordinator: ProactivityCoordinator,
  input: Readonly<{
    text: string;
    messageId: string;
    at: number;
    replyToMessageId: Option.Option<string>;
  }>
): Promise<Response> => {
  const { replyToMessageId, ...message } = input;
  const proof = Schema.decodeSync(WhatsAppTurnAdmission)({
    userId,
    portfolioId: recipient.portfolioId,
    bsuid: recipient.bsuid,
    businessPhoneNumberId: phone,
    occurredAtMs: input.at,
    receivedAtMs: input.at,
    ...message,
    ...Option.match(replyToMessageId, {
      onNone: () => ({}),
      onSome: (value) => ({ replyToMessageId: value }),
    }),
  });
  return coordinator.fetch(
    new Request("https://coordinator/hosted-turn/whatsapp", {
      method: "POST",
      body: Schema.encodeSync(Schema.fromJsonString(WhatsAppTurnAdmission))(proof),
    })
  );
};
const eventFor = (db: D1Database, at: DateTime.Utc): Promise<InsightEventId> =>
  db
    .prepare("SELECT id FROM insight_events WHERE user_id=? AND scheduled_at=?")
    .bind(userId, DateTime.formatIso(at))
    .first()
    .then((raw) => Schema.decodeUnknownSync(Schema.Struct({ id: InsightEventId }))(raw).id);
const readSummaryClaim = (db: D1Database, id: InsightEventId): Promise<typeof proofRow.Type> =>
  db
    .prepare(
      "SELECT correlation_token,provider_message_id FROM insight_whatsapp_claims WHERE user_id=? AND insight_event_id=?"
    )
    .bind(userId, id)
    .first()
    .then(Schema.decodeUnknownSync(proofRow));
const readQuestionClaim = (db: D1Database, id: string): Promise<typeof proofRow.Type> =>
  db
    .prepare(
      "SELECT correlation_token,provider_message_id FROM weekly_governor_questions WHERE user_id=? AND id=?"
    )
    .bind(userId, id)
    .first()
    .then(Schema.decodeUnknownSync(proofRow));
const testPromise = <A>(load: () => Promise<A>): Effect.Effect<A, Cause.UnknownError> =>
  Effect.tryPromise(load);
let attempts = 0;
const providerFetch = vi.fn<(input: Parameters<typeof globalThis.fetch>[0]) => Promise<Response>>(
  () => {
    attempts += 1;
    return Promise.resolve(
      Response.json({ messaging_product: "whatsapp", messages: [{ id: `provider-${attempts}` }] })
    );
  }
);
// Effect's Fetch reference retains its default transport. Keep one adapter, reset only its evidence.
const fakeProvider = (): typeof providerFetch => {
  attempts = 0;
  providerFetch.mockClear();
  return providerFetch;
};
const seed = (): Promise<Readonly<{ db: D1Database; at: DateTime.Utc }>> =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* weeklySummaryDatabaseAt(weeklySummaryTestNow);
      const schedule = yield* activateWeeklySummary({ db, now: weeklySummaryTestNow });
      yield* seedWeeklySummaryActivity({ db, at: "2026-08-04T12:00:00.000Z" });
      yield* testPromise(() =>
        db.batch([
          prepareInsightRecipient({
            db,
            userId,
            recipient,
            receivedAtMs: weeklySummaryTestNow.epochMilliseconds,
          }),
        ])
      );
      return { db, at: schedule.nextScheduledAt };
    })
  );
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
afterAll(() => weeklySummaryTestDatabases.dispose());

it.each(["reassociation", "withdrawal", "expiry", "withdrawal-expiry"])(
  "a queued question cannot send after %s",
  (change) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const fixture = yield* testPromise(seed);
        const clock = vi.spyOn(Date, "now").mockReturnValue(fixture.at.epochMilliseconds);
        const fetch = fakeProvider();
        vi.stubGlobal("fetch", fetch);
        const db = fixture.db;
        const coordinator = makeCoordinator(configuration(db));
        const schedule = Option.getOrThrow(yield* findWeeklySchedule({ db, userId }));
        yield* testPromise(() =>
          activity(coordinator, { kind: "weekly-generate", version: 1, userId, id: schedule.id })
        );
        const insightEventId = yield* testPromise(() => eventFor(db, fixture.at));
        yield* testPromise(() =>
          activity(coordinator, { kind: "weekly-summary", version: 1, userId, insightEventId })
        );
        const row = yield* testPromise(() => readSummaryClaim(db, insightEventId));
        expect(
          (yield* testPromise(() => delivered(coordinator, row, fixture.at.epochMilliseconds)))
            .status
        ).toBe(200);
        expect(fetch).toHaveBeenCalledOnce();
        if (change === "reassociation") {
          yield* testPromise(() =>
            db
              .prepare("UPDATE whatsapp_identities SET bsuid='CO.changed' WHERE user_id=?")
              .bind(userId)
              .run()
          );
        }
        if (change.startsWith("withdrawal")) {
          yield* withdrawWeeklyFixtureConsent({ db, userId, now: fixture.at.epochMilliseconds });
        }
        if (change.endsWith("expiry")) {
          clock.mockReturnValue(DateTime.add(fixture.at, { days: 2 }).epochMilliseconds);
        }
        const response = yield* testPromise(() =>
          activity(coordinator, { kind: "weekly-question", version: 1, userId, id: insightEventId })
        );
        expect(response.status).toBe(200);
        expect(fetch).toHaveBeenCalledOnce();
      })
    )
);

it("resource refusal prevents generation and provider send despite otherwise valid authority", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const fixture = yield* testPromise(seed);
      vi.spyOn(Date, "now").mockReturnValue(fixture.at.epochMilliseconds);
      const fetch = fakeProvider();
      vi.stubGlobal("fetch", fetch);
      const db = fixture.db;
      const coordinator = makeCoordinator(configuration(db));
      const schedule = Option.getOrThrow(yield* findWeeklySchedule({ db, userId }));
      const generation = { kind: "weekly-generate", version: 1, userId, id: schedule.id } as const;
      expect((yield* testPromise(() => activity(coordinator, generation))).status).toBe(200);
      const insightEventId = yield* testPromise(() => eventFor(db, fixture.at));
      for (let index = 0; index < 32; index++) {
        yield* admitWeeklyResource({ db, userId, now: fixture.at, phase: "send" });
        if (index < 31) {
          yield* admitWeeklyResource({ db, userId, now: fixture.at, phase: "generation" });
        }
      }
      expect(
        (yield* testPromise(() =>
          activity(coordinator, { kind: "weekly-summary", version: 1, userId, insightEventId })
        )).status
      ).toBe(503);
      expect((yield* testPromise(() => activity(coordinator, generation))).status).toBe(503);
      expect(fetch).not.toHaveBeenCalled();
    })
  ));

it("production coordinator sends each summary once, asks separately, counts only verified delivery, then pauses while preserving Consent", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const fixture = yield* testPromise(seed);
      const clock = vi.spyOn(Date, "now").mockReturnValue(fixture.at.epochMilliseconds);
      const fetch = fakeProvider();
      vi.stubGlobal("fetch", fetch);
      const coordinator = makeCoordinator(configuration(fixture.db));
      const schedule = Option.getOrThrow(yield* findWeeklySchedule({ db: fixture.db, userId }));
      expect(
        (yield* testPromise(() =>
          activity(coordinator, { kind: "weekly-generate", version: 1, userId, id: schedule.id })
        )).status
      ).toBe(200);
      const id = yield* testPromise(() => eventFor(fixture.db, fixture.at));
      const work = { kind: "weekly-summary", version: 1, userId, insightEventId: id } as const;
      expect((yield* testPromise(() => activity(coordinator, work))).status).toBe(200);
      expect((yield* testPromise(() => activity(coordinator, work))).status).toBe(200);
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(Option.isNone(yield* findWeeklyGovernor({ db: fixture.db, userId }))).toBe(true);
      const first = yield* testPromise(() => readSummaryClaim(fixture.db, id));
      expect(
        (yield* testPromise(() => delivered(coordinator, first, fixture.at.epochMilliseconds)))
          .status
      ).toBe(200);
      expect(
        (yield* testPromise(() => delivered(coordinator, first, fixture.at.epochMilliseconds)))
          .status
      ).toBe(200);
      expect(
        Option.getOrThrow(yield* findWeeklyGovernor({ db: fixture.db, userId }))
      ).toMatchObject({ unanswered: 1, _tag: "QuestionPending" });
      const question = { kind: "weekly-question", version: 1, userId, id } as const;
      expect((yield* testPromise(() => activity(coordinator, question))).status).toBe(200);
      expect((yield* testPromise(() => activity(coordinator, question))).status).toBe(200);
      expect(fetch).toHaveBeenCalledTimes(2);
      const asked = yield* testPromise(() => readQuestionClaim(fixture.db, id));
      expect(
        (yield* testPromise(() => delivered(coordinator, asked, fixture.at.epochMilliseconds)))
          .status
      ).toBe(200);
      expect(
        Option.getOrThrow(yield* findWeeklyGovernor({ db: fixture.db, userId }))
      ).toMatchObject({ unanswered: 1, _tag: "QuestionDelivered" });
      const next = Option.getOrThrow(yield* findWeeklySchedule({ db: fixture.db, userId }));
      clock.mockReturnValue(next.nextScheduledAt.epochMilliseconds);
      yield* testPromise(() =>
        fixture.db
          .prepare(
            "INSERT INTO transactions(id,user_id,amount,currency,category_id,direction,occurred_at,created_at) VALUES ('20000000-0000-4000-8000-000000000002',?,'12','COP',?,'outflow',?,?)"
          )
          .bind(
            userId,
            categoryIds.mercado,
            DateTime.formatIso(fixture.at),
            DateTime.formatIso(fixture.at)
          )
          .run()
      );
      expect(
        (yield* testPromise(() =>
          activity(coordinator, { kind: "weekly-generate", version: 1, userId, id: schedule.id })
        )).status
      ).toBe(200);
      const secondId = yield* testPromise(() => eventFor(fixture.db, next.nextScheduledAt));
      expect(
        (yield* testPromise(() => activity(coordinator, { ...work, insightEventId: secondId })))
          .status
      ).toBe(200);
      const second = yield* testPromise(() => readSummaryClaim(fixture.db, secondId));
      expect(
        (yield* testPromise(() =>
          delivered(coordinator, second, next.nextScheduledAt.epochMilliseconds)
        )).status
      ).toBe(200);
      const governor = Option.getOrThrow(yield* findWeeklyGovernor({ db: fixture.db, userId }));
      expect(governor.unanswered).toBe(2);
      expect(governor._tag).toBe("Paused");
      expect(Option.getOrThrow(yield* findWeeklySchedule({ db: fixture.db, userId })).enabled).toBe(
        false
      );
      expect(Option.isSome(yield* findWeeklyConsentGrant({ db: fixture.db, userId }))).toBe(true);
      expect(
        yield* testPromise(() =>
          fixture.db
            .prepare("SELECT COUNT(*) AS count FROM proactive_transcript_entries WHERE user_id=?")
            .bind(userId)
            .first()
        )
      ).toEqual({ count: 2 });
    })
  ));

it("a contextual no revokes the category permanently; only a fresh explicit request can re-enable it", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const fixture = yield* testPromise(seed);
      const clock = vi.spyOn(Date, "now").mockReturnValue(fixture.at.epochMilliseconds);
      const fetch = fakeProvider();
      vi.stubGlobal("fetch", fetch);
      const coordinator = makeCoordinator(configuration(fixture.db));
      const schedule = Option.getOrThrow(yield* findWeeklySchedule({ db: fixture.db, userId }));
      yield* testPromise(() =>
        activity(coordinator, { kind: "weekly-generate", version: 1, userId, id: schedule.id })
      );
      const id = yield* testPromise(() => eventFor(fixture.db, fixture.at));
      yield* testPromise(() =>
        activity(coordinator, { kind: "weekly-summary", version: 1, userId, insightEventId: id })
      );
      const summary = yield* testPromise(() => readSummaryClaim(fixture.db, id));
      yield* testPromise(() => delivered(coordinator, summary, fixture.at.epochMilliseconds));
      yield* testPromise(() =>
        activity(coordinator, { kind: "weekly-question", version: 1, userId, id })
      );
      const question = yield* testPromise(() => readQuestionClaim(fixture.db, id));
      expect(
        (yield* testPromise(() =>
          inbound(coordinator, {
            text: "no",
            messageId: "before-disclosed",
            at: fixture.at.epochMilliseconds,
            replyToMessageId: Option.some(question.provider_message_id),
          })
        )).status
      ).toBe(503);
      expect(Option.isSome(yield* findWeeklyConsentGrant({ db: fixture.db, userId }))).toBe(true);
      yield* testPromise(() => delivered(coordinator, question, fixture.at.epochMilliseconds));
      expect(
        (yield* testPromise(() =>
          inbound(coordinator, {
            text: "reactivar resumen semanal",
            messageId: "older-request",
            at: fixture.at.epochMilliseconds,
            replyToMessageId: Option.none(),
          })
        )).status
      ).toBe(202);
      clock.mockReturnValue(fixture.at.epochMilliseconds + 1);
      const no = {
        text: "no",
        messageId: "decline",
        at: fixture.at.epochMilliseconds + 1,
        replyToMessageId: Option.some(question.provider_message_id),
      };
      expect((yield* testPromise(() => inbound(coordinator, no))).status).toBe(200);
      expect((yield* testPromise(() => inbound(coordinator, no))).status).toBe(200);
      expect(Option.isNone(yield* findWeeklyConsentGrant({ db: fixture.db, userId }))).toBe(true);
      expect(
        Option.getOrThrow(yield* findWeeklyGovernor({ db: fixture.db, userId })).unanswered
      ).toBe(0);
      expect(Option.getOrThrow(yield* findWeeklySchedule({ db: fixture.db, userId })).enabled).toBe(
        false
      );
      expect(
        Option.isNone(
          yield* createWeeklyGovernorConsentOffer({
            db: fixture.db,
            userId,
            caller: weeklySummaryTestCaller,
            now: DateTime.makeUnsafe(fixture.at.epochMilliseconds + 1),
            request: { _tag: "ShortOffer", origin: "proactive" },
          })
        )
      ).toBe(true);
      const older = yield* Schema.decodeUnknownEffect(Schema.Struct({ id: Schema.String }))(
        yield* testPromise(() =>
          fixture.db
            .prepare(
              "SELECT id FROM weekly_question_intents WHERE user_id=? AND request_message_id='older-request'"
            )
            .bind(userId)
            .first()
        )
      );
      yield* testPromise(() =>
        activity(coordinator, { kind: "weekly-question", version: 1, userId, id: older.id })
      );
      expect(fetch).toHaveBeenCalledTimes(2);
      clock.mockReturnValue(fixture.at.epochMilliseconds + 2);
      const request = {
        text: "reactivar resumen semanal",
        messageId: "fresh-request",
        at: fixture.at.epochMilliseconds + 2,
        replyToMessageId: Option.none(),
      };
      expect((yield* testPromise(() => inbound(coordinator, request))).status).toBe(202);
      expect((yield* testPromise(() => inbound(coordinator, request))).status).toBe(202);
      const fresh = yield* Schema.decodeUnknownEffect(Schema.Struct({ id: Schema.String }))(
        yield* testPromise(() =>
          fixture.db
            .prepare(
              "SELECT id FROM weekly_question_intents WHERE user_id=? AND request_message_id='fresh-request'"
            )
            .bind(userId)
            .first()
        )
      );
      expect(
        (yield* testPromise(() =>
          activity(coordinator, { kind: "weekly-question", version: 1, userId, id: fresh.id })
        )).status
      ).toBe(200);
      const offered = yield* testPromise(() => readQuestionClaim(fixture.db, fresh.id));
      yield* testPromise(() => delivered(coordinator, offered, fixture.at.epochMilliseconds + 2));
      expect(
        (yield* testPromise(() =>
          inbound(coordinator, {
            text: "sí",
            messageId: "reenable",
            at: fixture.at.epochMilliseconds + 2,
            replyToMessageId: Option.some(offered.provider_message_id),
          })
        )).status
      ).toBe(200);
      expect(Option.getOrThrow(yield* findWeeklySchedule({ db: fixture.db, userId })).enabled).toBe(
        true
      );
      expect(Option.isSome(yield* findWeeklyConsentGrant({ db: fixture.db, userId }))).toBe(true);
      expect(fetch).toHaveBeenCalledTimes(3);
    })
  ));

it("a verified contextual reply resets attention before inference; unrelated messages do not", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const fixture = yield* testPromise(seed);
      const clock = vi.spyOn(Date, "now").mockReturnValue(fixture.at.epochMilliseconds);
      const fetch = fakeProvider();
      vi.stubGlobal("fetch", fetch);
      const coordinator = makeCoordinator(configuration(fixture.db));
      const schedule = Option.getOrThrow(yield* findWeeklySchedule({ db: fixture.db, userId }));
      yield* testPromise(() =>
        activity(coordinator, { kind: "weekly-generate", version: 1, userId, id: schedule.id })
      );
      const id = yield* testPromise(() => eventFor(fixture.db, fixture.at));
      yield* testPromise(() =>
        activity(coordinator, { kind: "weekly-summary", version: 1, userId, insightEventId: id })
      );
      const summary = yield* testPromise(() => readSummaryClaim(fixture.db, id));
      yield* testPromise(() => delivered(coordinator, summary, fixture.at.epochMilliseconds));
      clock.mockReturnValue(fixture.at.epochMilliseconds + 1);
      expect(
        (yield* testPromise(() =>
          inbound(coordinator, {
            text: "hola",
            messageId: "unrelated",
            at: fixture.at.epochMilliseconds + 1,
            replyToMessageId: Option.none(),
          })
        )).status
      ).toBe(503);
      expect(
        Option.getOrThrow(yield* findWeeklyGovernor({ db: fixture.db, userId })).unanswered
      ).toBe(1);
      expect(
        (yield* testPromise(() =>
          inbound(coordinator, {
            text: "gracias",
            messageId: "contextual",
            at: fixture.at.epochMilliseconds + 1,
            replyToMessageId: Option.some(summary.provider_message_id),
          })
        )).status
      ).toBe(503);
      expect(
        Option.getOrThrow(yield* findWeeklyGovernor({ db: fixture.db, userId }))
      ).toMatchObject({ unanswered: 0, _tag: "Attentive" });
      yield* testPromise(() =>
        activity(coordinator, { kind: "weekly-question", version: 1, userId, id })
      );
      expect(fetch).toHaveBeenCalledTimes(1);
    })
  ));

it("missing configuration, invalid knobs and foreign coordinator identities fail closed before any provider send", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const fixture = yield* testPromise(seed);
      vi.spyOn(Date, "now").mockReturnValue(fixture.at.epochMilliseconds);
      const fetch = fakeProvider();
      vi.stubGlobal("fetch", fetch);
      const schedule = Option.getOrThrow(yield* findWeeklySchedule({ db: fixture.db, userId }));
      const work = { kind: "weekly-generate", version: 1, userId, id: schedule.id } as const;
      for (const environment of [
        { DB: fixture.db },
        { ...configuration(fixture.db), WEEKLY_QUESTION_TEMPLATE_JSON: "" },
        { ...configuration(fixture.db), PROACTIVITY_ASK_AFTER: "0" },
      ]) {
        expect(
          (yield* testPromise(() => activity(makeCoordinator(environment), work))).status
        ).toBe(503);
      }
      expect(
        (yield* testPromise(() =>
          activity(makeCoordinator(configuration(fixture.db)), {
            ...work,
            userId: weeklySummaryOtherUser,
          })
        )).status
      ).toBe(503);
      expect(fetch).not.toHaveBeenCalled();
      expect(
        yield* testPromise(() =>
          fixture.db.prepare("SELECT COUNT(*) AS count FROM insight_events").first()
        )
      ).toEqual({ count: 0 });
    })
  ));
