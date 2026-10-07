import type { WorkflowStep } from "cloudflare:workers";
import type { Cause } from "effect";
import type {
  ConsentUnavailable,
  ProactivityConsentContext,
  ProactivityConsentOffer,
} from "../consent/contract";
import type { InsightUnavailable } from "./contract";
import type { InsightEventId } from "../../src/core/insights/contract";
import {
  makeExecutingWeeklyFixtureStep,
  makeProactivityCoordinator,
  proactivityWorkflowHarness,
} from "../weekly-summary.test-fixture";
import { prepareInsightRecipient, proactivityRejectedDeliveryQuery } from "../whatsapp/operations";
import { WhatsAppStatusAdmission } from "../whatsapp/contract";
import { ProactivityActivity, ProactivityDeliveryWork } from "./contract";
import {
  HostedDeliveryCorrelationToken,
  ProactivityTemplateConfiguration,
  WhatsAppBusinessPhoneNumberId,
  WhatsAppProviderMessageId,
} from "../../src/shell/channels/whatsapp/contract";
import { readProactiveTranscript } from "../agent/operations";
import { evaluateRecurringSeries } from "../recurring/operations";

import { afterAll, afterEach, beforeEach, expect, it, vi } from "vitest";
import { DateTime, Effect, Option, Schema } from "effect";
import {
  proactivityDatabase,
  proactivityTestCallers,
  proactivityTestDatabases,
  proactivityTestPAT,
  proactivityTestUsers,
  seedLargeRecurringDigestSource,
  seedRecurringDigestSource,
} from "../proactivity.test-fixture";
import {
  createProactivityConsentOffer,
  findCurrentProactivityOffer,
  findProactivityConsentGrant,
  recordProactivityConsentDisclosure,
  replaceProactivityConsentOffer,
} from "../consent/operations";
import {
  advanceRecurringDigest,
  findInsight,
  findRecurringDigestReport,
  readCanonicalRecurringDigestReport,
  recordRecurringDigestDecision,
  requestRecurringDigestOffer,
} from "./operations";

const externalProvider = vi.fn<typeof fetch>();
beforeEach(() => {
  externalProvider.mockReset();
  vi.stubGlobal("fetch", externalProvider);
});
afterAll(() => proactivityTestDatabases.dispose());
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("records same-User recurring Consent and standing atomically and rejects a foreign disclosure choice", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* proactivityDatabase;
      const context = {
        db,
        userId: proactivityTestUsers[0],
        caller: proactivityTestCallers[0],
        kind: "new-recurring-series" as const,
        now: DateTime.makeUnsafe("2026-10-06T18:00:00Z"),
      };
      const offer = Option.getOrThrow(yield* createProactivityConsentOffer(context));
      yield* recordProactivityConsentDisclosure({
        ...context,
        offerId: offer.id,
        disclosureMessageId: "recurring-disclosed",
      });
      expect(
        yield* recordRecurringDigestDecision({
          ...context,
          userId: proactivityTestUsers[1],
          caller: proactivityTestCallers[1],
          choice: offer.acceptChoice,
          decisionMessageId: "foreign-choice",
        })
      ).toBe(false);
      expect(
        Option.isNone(
          yield* findProactivityConsentGrant({ ...context, userId: proactivityTestUsers[1] })
        )
      ).toBe(true);
      expect(
        yield* recordRecurringDigestDecision({
          ...context,
          choice: offer.acceptChoice,
          decisionMessageId: "recurring-accept",
        })
      ).toBe(true);
      const grant = Option.getOrThrow(yield* findProactivityConsentGrant(context));
      const row = yield* Effect.tryPromise(() =>
        db
          .prepare(
            "SELECT enabled,grant_id,acceptance_from_ms FROM recurring_digest_instructions WHERE user_id=?"
          )
          .bind(context.userId)
          .first()
      );
      expect(row).toMatchObject({
        enabled: 1,
        grant_id: grant.id,
        acceptance_from_ms: DateTime.makeUnsafe("2026-10-06T05:00:00Z").epochMilliseconds,
      });
      expect(
        yield* recordRecurringDigestDecision({
          ...context,
          choice: offer.acceptChoice,
          decisionMessageId: "replayed-accept",
        })
      ).toBe(false);
    })
  ));

it("freezes all eligible confirmations of a closed captured day into one next-morning report, including late discoveries", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* proactivityDatabase;
      const userId = proactivityTestUsers[0];
      const accepted = DateTime.makeUnsafe("2026-10-06T18:00:00Z");
      const context = {
        db,
        userId,
        caller: proactivityTestCallers[0],
        kind: "new-recurring-series" as const,
        now: accepted,
      };
      const offer = Option.getOrThrow(yield* createProactivityConsentOffer(context));
      yield* recordProactivityConsentDisclosure({
        ...context,
        offerId: offer.id,
        disclosureMessageId: "digest-offer",
      });
      yield* recordRecurringDigestDecision({
        ...context,
        choice: offer.acceptChoice,
        decisionMessageId: "digest-opt-in",
      });
      yield* seedRecurringDigestSource({
        db,
        userId,
        confirmedAt: "2026-10-06T19:00:00.000Z",
        counterparty: "Netflix",
        index: 1,
      });
      yield* seedRecurringDigestSource({
        db,
        userId,
        confirmedAt: "2026-10-07T04:59:59.000Z",
        counterparty: "Amazon",
        index: 2,
      });
      vi.spyOn(Date, "now").mockReturnValue(
        DateTime.makeUnsafe("2026-10-07T04:59:59Z").epochMilliseconds
      );
      const early = yield* advanceRecurringDigest({
        db,
        userId,
        now: DateTime.makeUnsafe("2026-10-07T04:59:59Z"),
      });
      expect(early._tag).not.toBe("Created");
      vi.spyOn(Date, "now").mockReturnValue(
        DateTime.makeUnsafe("2026-10-07T05:00:00Z").epochMilliseconds
      );
      const frozen = yield* advanceRecurringDigest({
        db,
        userId,
        now: DateTime.makeUnsafe("2026-10-07T05:00:00Z"),
      });
      if (frozen._tag !== "Created") return yield* Effect.die("Expected complete digest");
      const report = Option.getOrThrow(
        yield* findRecurringDigestReport({ db, userId, id: frozen.id })
      );
      expect(report.payload.items.map((item) => item.counterparty)).toEqual(["Amazon", "Netflix"]);
      expect(DateTime.formatIso(report.scheduledAt)).toBe("2026-10-07T14:00:00.000Z");
      expect(
        Option.isNone(
          yield* findRecurringDigestReport({ db, userId: proactivityTestUsers[1], id: frozen.id })
        )
      ).toBe(true);
      expect(
        (yield* advanceRecurringDigest({
          db,
          userId,
          now: DateTime.makeUnsafe("2026-10-07T14:00:00Z"),
        }))._tag
      ).not.toBe("Created");
    })
  ));

const activateDigest = (
  db: D1Database
): Effect.Effect<
  ProactivityConsentContext & Readonly<{ offer: ProactivityConsentOffer }>,
  ConsentUnavailable | InsightUnavailable
> =>
  Effect.gen(function* () {
    const context = {
      db,
      userId: proactivityTestUsers[0],
      caller: proactivityTestCallers[0],
      kind: "new-recurring-series" as const,
      now: DateTime.makeUnsafe("2026-10-06T18:00:00Z"),
    };
    const offer = Option.getOrThrow(yield* createProactivityConsentOffer(context));
    yield* recordProactivityConsentDisclosure({
      ...context,
      offerId: offer.id,
      disclosureMessageId: "digest-disclosure",
    });
    yield* recordRecurringDigestDecision({
      ...context,
      choice: offer.acceptChoice,
      decisionMessageId: "digest-accept",
    });
    return { ...context, offer };
  });
const closedNow = DateTime.makeUnsafe("2026-10-07T14:00:00Z");
const freezeDigest = (db: D1Database): Effect.Effect<InsightEventId, InsightUnavailable> =>
  Effect.gen(function* () {
    vi.spyOn(Date, "now").mockReturnValue(closedNow.epochMilliseconds);
    const result = yield* advanceRecurringDigest({
      db,
      userId: proactivityTestUsers[0],
      now: closedNow,
    });
    if (result._tag !== "Created") return yield* Effect.die("Expected complete digest");
    return result.id;
  });

it("rolls back legal acceptance when native instruction activation cannot commit", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* proactivityDatabase;
      const context = {
        db,
        userId: proactivityTestUsers[0],
        caller: proactivityTestCallers[0],
        kind: "new-recurring-series" as const,
        now: DateTime.makeUnsafe("2026-10-06T18:00:00Z"),
      };
      const offer = Option.getOrThrow(yield* createProactivityConsentOffer(context));
      yield* recordProactivityConsentDisclosure({
        ...context,
        offerId: offer.id,
        disclosureMessageId: "rollback-disclosure",
      });
      yield* Effect.tryPromise(() =>
        db
          .prepare(
            "CREATE TRIGGER test_recurring_activation BEFORE INSERT ON recurring_digest_instructions BEGIN SELECT RAISE(ABORT,'activation_refused'); END"
          )
          .run()
      );
      expect(
        (yield* Effect.exit(
          recordRecurringDigestDecision({
            ...context,
            choice: offer.acceptChoice,
            decisionMessageId: "rollback-choice",
          })
        ))._tag
      ).toBe("Failure");
      expect(Option.isNone(yield* findProactivityConsentGrant(context))).toBe(true);
      yield* Effect.tryPromise(() => db.prepare("DROP TRIGGER test_recurring_activation").run());
      expect(
        yield* recordRecurringDigestDecision({
          ...context,
          choice: offer.acceptChoice,
          decisionMessageId: "rollback-choice",
        })
      ).toBe(true);
    })
  ));

it("requires every source page, recovers after revision changes, and links the entire large report without truncation", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* proactivityDatabase;
      const context = yield* activateDigest(db);
      yield* seedLargeRecurringDigestSource({
        db,
        userId: context.userId,
        confirmedAt: "2026-10-06T19:00:00Z",
        count: 33,
      });
      vi.spyOn(Date, "now").mockReturnValue(closedNow.epochMilliseconds);
      expect((yield* advanceRecurringDigest({ ...context, now: closedNow }))._tag).toBe("Progress");
      expect(
        yield* Effect.tryPromise(() =>
          db.prepare("SELECT count(*) AS total FROM recurring_digest_reports").first()
        )
      ).toEqual({ total: 0 });
      // A real effective fact change invalidates the old bounded traversal.
      yield* Effect.tryPromise(() =>
        db
          .prepare(
            "UPDATE transactions SET amount='54321.01' WHERE id='29000000-0000-4000-8000-000000000007'"
          )
          .run()
      );
      expect(
        (yield* Effect.exit(advanceRecurringDigest({ ...context, now: closedNow })))._tag
      ).toBe("Failure");
      yield* Effect.forEach(Array.from({ length: 45 }), () => evaluateRecurringSeries(context), {
        discard: true,
      });
      expect((yield* advanceRecurringDigest({ ...context, now: closedNow }))._tag).toBe("Progress");
      const id = yield* freezeDigest(db);
      const report = Option.getOrThrow(yield* findRecurringDigestReport({ ...context, id }));
      expect(report.payload.items).toHaveLength(32);
      expect(
        yield* Effect.tryPromise((): Promise<unknown> =>
          db.prepare("SELECT text FROM proactivity_reports WHERE delivery_id=?").bind(id).first()
        )
      ).toMatchObject({
        text: `Nuevos patrones históricos de cargos recurrentes del 2026-10-06. No indica que sigan activos.\n32 patrones. Informe completo: https://app.fidyapp.com/insights/recurring/${id}`,
      });
      expect(
        yield* Effect.tryPromise(() =>
          db.prepare("SELECT count(*) AS total FROM recurring_digest_consumption").first()
        )
      ).toEqual({ total: 33 });
      expect((yield* advanceRecurringDigest({ ...context, now: closedNow }))._tag).toBe("Progress");
      expect((yield* advanceRecurringDigest({ ...context, now: closedNow }))._tag).toBe("NoWork");
      expect((yield* freezeDigest(db).pipe(Effect.exit))._tag).toBe("Failure");
    })
  ));

it("retains frozen historical facts after invalidation and rejects foreign, underscoped and revoked canonical readers", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* proactivityDatabase;
      const context = yield* activateDigest(db);
      yield* seedRecurringDigestSource({
        ...context,
        confirmedAt: "2026-10-06T19:00:00Z",
        counterparty: "<script>histórico</script>",
        index: 1,
      });
      const id = yield* freezeDigest(db);
      const subject = yield* proactivityTestPAT(db);
      yield* Effect.tryPromise(() =>
        db
          .prepare("UPDATE pats SET expires_at_ms=? WHERE id=?")
          .bind(closedNow.epochMilliseconds + 600000, subject.patId)
          .run()
      );
      const input = { db, subject, current: closedNow.epochMilliseconds, id };
      const malformed = yield* readCanonicalRecurringDigestReport({ ...input, id: "not-a-uuid" });
      expect(malformed.status).toBe(400);
      expect(yield* Effect.tryPromise((): Promise<unknown> => malformed.json())).toMatchObject({
        error: { code: "validation_failed" },
      });
      expect(
        yield* Effect.tryPromise(() =>
          db
            .prepare(
              "SELECT outcome FROM pat_audit WHERE operation='insights.getRecurringDigestReport' ORDER BY rowid DESC LIMIT 1"
            )
            .first()
        )
      ).toEqual({ outcome: "rejected" });
      const valid = yield* readCanonicalRecurringDigestReport(input);
      expect(valid.status).toBe(200);
      expect(valid.headers.get("cache-control")).toBe("no-store");
      expect(yield* Effect.tryPromise((): Promise<unknown> => valid.json())).toMatchObject({
        data: { payload: { items: [{ counterparty: "<script>histórico</script>" }] } },
      });
      const foreign = { ...subject, userId: proactivityTestUsers[1] };
      yield* Effect.tryPromise(() =>
        db.prepare("UPDATE pats SET user_id=? WHERE id=?").bind(foreign.userId, subject.patId).run()
      );
      expect(
        (yield* readCanonicalRecurringDigestReport({ ...input, subject: foreign })).status
      ).toBe(404);
      yield* Effect.tryPromise(() =>
        db.prepare("UPDATE pats SET user_id=? WHERE id=?").bind(subject.userId, subject.patId).run()
      );
      yield* Effect.tryPromise(() =>
        db.prepare("UPDATE pats SET scopes_json='[\"write\"]' WHERE id=?").bind(subject.patId).run()
      );
      expect((yield* readCanonicalRecurringDigestReport(input)).status).not.toBe(200);
      yield* Effect.tryPromise(() =>
        db.prepare("UPDATE pats SET scopes_json='[\"read\"]' WHERE id=?").bind(subject.patId).run()
      );
      yield* Effect.tryPromise(() =>
        db
          .prepare("UPDATE transactions SET amount='1.00' WHERE user_id=?")
          .bind(context.userId)
          .run()
      );
      yield* Effect.forEach(Array.from({ length: 12 }), () => evaluateRecurringSeries(context), {
        discard: true,
      });
      expect(
        Option.getOrThrow(yield* findRecurringDigestReport({ ...context, id })).payload.items
      ).toHaveLength(1);
      expect((yield* readCanonicalRecurringDigestReport(input)).status).toBe(200);
      yield* Effect.tryPromise(() =>
        db
          .prepare("UPDATE pats SET revoked_at_ms=? WHERE id=?")
          .bind(input.current, subject.patId)
          .run()
      );
      expect((yield* readCanonicalRecurringDigestReport(input)).status).not.toBe(200);
    })
  ));

const setupDigestCoordinator = (
  db: D1Database
): Effect.Effect<
  Readonly<{
    coordinator: ReturnType<typeof makeProactivityCoordinator>;
    phone: WhatsAppBusinessPhoneNumberId;
  }>,
  Cause.UnknownError | Schema.SchemaError
> =>
  Effect.gen(function* () {
    const caller = proactivityTestCallers[0];
    const phone = WhatsAppBusinessPhoneNumberId.make("123456789");
    yield* Effect.tryPromise(() =>
      db.batch([
        prepareInsightRecipient({
          db,
          userId: proactivityTestUsers[0],
          recipient: {
            portfolioId: caller.businessPortfolioId,
            bsuid: caller.businessScopedUserId,
            businessPhoneNumberId: phone,
          },
          receivedAtMs: closedNow.epochMilliseconds,
        }),
      ])
    );
    const coordinator = makeProactivityCoordinator({
      userId: proactivityTestUsers[0],
      environment: {
        DB: db,
        PROACTIVITY_ENABLED: "enabled",
        KAPSO_API_KEY: "test-only",
        PROACTIVITY_TEMPLATE_JSON: yield* Schema.encodeEffect(
          Schema.fromJsonString(ProactivityTemplateConfiguration)
        )({ name: "fidy_proactivity", language: "es", approval: "approved", body: "Fidy: {{1}}" }),
      },
    });
    return { coordinator, phone };
  });
const digestWork = (work: ProactivityActivity): Request =>
  new Request("https://coordinator/proactivity-work", {
    method: "POST",
    body: Schema.encodeSync(Schema.fromJsonString(ProactivityActivity))(work),
  });

it("uses the installed coordinator for one-shot delivery and settles the exact transcript only on verified evidence", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* proactivityDatabase;
      const context = yield* activateDigest(db);
      yield* seedRecurringDigestSource({
        ...context,
        confirmedAt: "2026-10-06T19:00:00Z",
        counterparty: "Netflix",
        index: 1,
      });
      const id = yield* freezeDigest(db);
      const { coordinator, phone } = yield* setupDigestCoordinator(db);
      const provider = externalProvider.mockImplementation(() =>
        Promise.resolve(
          Response.json({ messaging_product: "whatsapp", messages: [{ id: "digest-provider" }] })
        )
      );
      const work = {
        kind: "proactivity-delivery" as const,
        version: 1 as const,
        userId: context.userId,
        id,
      };
      expect(
        (yield* Effect.tryPromise(() =>
          coordinator.fetch(digestWork({ ...work, userId: proactivityTestUsers[1] }))
        )).status
      ).not.toBe(200);
      expect(provider).not.toHaveBeenCalled();
      expect((yield* Effect.tryPromise(() => coordinator.fetch(digestWork(work)))).status).toBe(
        200
      );
      expect((yield* Effect.tryPromise(() => coordinator.fetch(digestWork(work)))).status).toBe(
        200
      );
      expect(provider).toHaveBeenCalledOnce();
      expect(Option.getOrThrow(yield* findInsight({ ...context, id })).lifecycleState).toBe(
        "pending"
      );
      expect(
        Option.isNone(
          yield* readProactiveTranscript({
            db,
            userId: context.userId,
            insightEventId: id,
            now: closedNow.epochMilliseconds,
          })
        )
      ).toBe(true);
      const claim = yield* Schema.decodeUnknownEffect(
        Schema.Struct({ correlation_token: HostedDeliveryCorrelationToken })
      )(
        yield* Effect.tryPromise(() =>
          db
            .prepare(
              "SELECT correlation_token FROM proactivity_whatsapp_claims WHERE delivery_id=?"
            )
            .bind(id)
            .first()
        )
      );
      const status = {
        userId: context.userId,
        correlationToken: claim.correlation_token,
        businessPhoneNumberId: phone,
        providerMessageId: WhatsAppProviderMessageId.make("digest-provider"),
        outcome: "delivered" as const,
        occurredAtMs: closedNow.epochMilliseconds,
        receivedAtMs: closedNow.epochMilliseconds,
      };
      const notify = (value: typeof status): Promise<Response> =>
        coordinator.fetch(
          new Request("https://coordinator/hosted-turn/whatsapp/status", {
            method: "POST",
            body: Schema.encodeSync(Schema.fromJsonString(WhatsAppStatusAdmission))(value),
          })
        );
      expect(
        (yield* Effect.tryPromise(() => notify({ ...status, userId: proactivityTestUsers[1] })))
          .status
      ).not.toBe(200);
      expect((yield* Effect.tryPromise(() => notify(status))).status).toBe(200);
      expect((yield* Effect.tryPromise(() => notify(status))).status).toBe(200);
      expect(Option.getOrThrow(yield* findInsight({ ...context, id })).lifecycleState).toBe(
        "delivered"
      );
      const transcript = Option.getOrThrow(
        yield* readProactiveTranscript({
          db,
          userId: context.userId,
          insightEventId: id,
          now: closedNow.epochMilliseconds,
        })
      );
      expect(transcript.text).toContain("Netflix");
      expect(
        yield* Effect.tryPromise(() =>
          db
            .prepare(
              "SELECT count(*) AS total FROM proactive_transcript_event_links WHERE insight_event_id=?"
            )
            .bind(id)
            .first()
        )
      ).toEqual({ total: 1 });
    })
  ));

it("rechecks exact recurring permission before send and preserves the frozen report after opt-out", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* proactivityDatabase;
      const context = yield* activateDigest(db);
      yield* seedRecurringDigestSource({
        ...context,
        confirmedAt: "2026-10-06T19:00:00Z",
        counterparty: "Netflix",
        index: 1,
      });
      const id = yield* freezeDigest(db);
      const { coordinator } = yield* setupDigestCoordinator(db);
      expect(
        yield* recordRecurringDigestDecision({
          ...context,
          now: closedNow,
          choice: context.offer.revokeChoice,
          decisionMessageId: "digest-opt-out",
        })
      ).toBe(true);
      const provider = externalProvider.mockImplementation(() =>
        Promise.resolve(Response.json({ messages: [{ id: "must-not-send" }] }))
      );
      expect(
        (yield* Effect.tryPromise(() =>
          coordinator.fetch(
            digestWork({ kind: "proactivity-delivery", version: 1, userId: context.userId, id })
          )
        )).status
      ).toBe(200);
      expect(provider).not.toHaveBeenCalled();
      expect(
        Option.getOrThrow(yield* findRecurringDigestReport({ ...context, id })).payload.items
      ).toHaveLength(1);
    })
  ));

it("offers once on foreground discovery, replaces a definitively rejected disclosure, and never repeats an ambiguous send", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* proactivityDatabase;
      const context = {
        db,
        userId: proactivityTestUsers[0],
        caller: proactivityTestCallers[0],
        kind: "new-recurring-series" as const,
        now: closedNow,
      };
      yield* seedRecurringDigestSource({
        ...context,
        confirmedAt: "2026-10-06T19:00:00Z",
        counterparty: "Netflix",
        index: 1,
      });
      vi.spyOn(Date, "now").mockReturnValue(closedNow.epochMilliseconds);
      const { coordinator } = yield* setupDigestCoordinator(db);
      yield* requestRecurringDigestOffer({ ...context, messageId: "foreground-1" });
      const generate = (): Promise<Response> =>
        coordinator.fetch(
          digestWork({ kind: "proactivity-generate", version: 1, userId: context.userId })
        );
      expect((yield* Effect.tryPromise(generate)).status).toBe(200);
      const first = Option.getOrThrow(yield* findCurrentProactivityOffer(context));
      yield* requestRecurringDigestOffer({ ...context, messageId: "foreground-pending" });
      expect(
        yield* Effect.tryPromise(() =>
          db
            .prepare(
              "SELECT count(*) AS total FROM proactivity_offer_requests WHERE kind='new-recurring-series'"
            )
            .first()
        )
      ).toEqual({ total: 1 });
      const provider = externalProvider.mockImplementation(() =>
        Promise.resolve(new Response("rejected", { status: 401 }))
      );
      const send = (id: string): Promise<Response> =>
        coordinator.fetch(
          digestWork({ kind: "proactivity-delivery", version: 1, userId: context.userId, id })
        );
      expect((yield* Effect.tryPromise(() => send(first.id))).status).toBe(200);
      expect(
        yield* Effect.tryPromise(() =>
          db
            .prepare(
              "SELECT state,scheduled_at_ms,expires_at_ms FROM proactivity_whatsapp_claims WHERE delivery_id=?"
            )
            .bind(first.id)
            .first()
        )
      ).toEqual({
        state: "rejected",
        scheduled_at_ms: closedNow.epochMilliseconds,
        expires_at_ms: closedNow.epochMilliseconds + 600000,
      });
      expect(provider).toHaveBeenCalledOnce();
      const foreignContext = {
        ...context,
        userId: proactivityTestUsers[1],
        caller: proactivityTestCallers[1],
      };
      const foreignOffer = Option.getOrThrow(yield* createProactivityConsentOffer(foreignContext));
      expect(
        Option.isNone(
          yield* replaceProactivityConsentOffer({
            ...foreignContext,
            replacement: {
              offerId: foreignOffer.id,
              proof: proactivityRejectedDeliveryQuery({ ...context, id: first.id }),
            },
          })
        )
      ).toBe(true);
      yield* requestRecurringDigestOffer({ ...context, messageId: "foreground-retry" });
      expect(
        yield* Effect.tryPromise(() =>
          db
            .prepare(
              "SELECT count(*) AS total FROM proactivity_offer_requests WHERE kind='new-recurring-series'"
            )
            .first()
        )
      ).toEqual({ total: 2 });
      expect((yield* Effect.tryPromise(generate)).status).toBe(200);
      const second = Option.getOrThrow(yield* findCurrentProactivityOffer(context));
      expect(second.id).not.toBe(first.id);
      provider.mockImplementation(() => Promise.reject(new Error("unknown transport outcome")));
      expect((yield* Effect.tryPromise(() => send(second.id))).status).toBe(200);
      yield* requestRecurringDigestOffer({ ...context, messageId: "foreground-ambiguous" });
      expect(
        yield* Effect.tryPromise(() =>
          db
            .prepare(
              "SELECT count(*) AS total FROM proactivity_offer_requests WHERE kind='new-recurring-series'"
            )
            .first()
        )
      ).toEqual({ total: 2 });
    })
  ));

it("preserves later same-date discoveries after backward travel in their distinct captured windows", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* proactivityDatabase;
      const context = yield* activateDigest(db);
      yield* seedRecurringDigestSource({
        ...context,
        confirmedAt: "2026-10-06T19:00:00Z",
        counterparty: "Primero",
        index: 1,
      });
      const firstClose = DateTime.makeUnsafe("2026-10-07T05:00:00Z");
      vi.spyOn(Date, "now").mockReturnValue(firstClose.epochMilliseconds);
      const first = yield* advanceRecurringDigest({ ...context, now: firstClose });
      if (first._tag !== "Created") return yield* Effect.die("Expected initial captured day");
      const before = Option.getOrThrow(
        yield* findRecurringDigestReport({ ...context, id: first.id })
      );
      yield* Effect.tryPromise(() =>
        db
          .prepare("UPDATE users SET time_zone='Pacific/Honolulu' WHERE id=?")
          .bind(context.userId)
          .run()
      );
      yield* seedRecurringDigestSource({
        ...context,
        confirmedAt: "2026-10-07T09:00:00Z",
        counterparty: "Después",
        index: 2,
      });
      const secondId = yield* freezeDigest(db);
      const after = Option.getOrThrow(
        yield* findRecurringDigestReport({ ...context, id: secondId })
      );
      expect(after.payload.confirmationDay.localDate).toBe(
        before.payload.confirmationDay.localDate
      );
      expect(after.payload.confirmationDay.from.epochMilliseconds).not.toBe(
        before.payload.confirmationDay.from.epochMilliseconds
      );
      expect(after.payload.items.map((item) => item.counterparty)).toEqual(["Después"]);
      expect(DateTime.formatIso(after.scheduledAt)).toBe("2026-10-07T19:00:00.000Z");
      expect(
        Option.getOrThrow(yield* findRecurringDigestReport({ ...context, id: first.id }))
      ).toEqual(before);
      expect(
        yield* Effect.tryPromise(() =>
          db.prepare("SELECT count(*) AS total FROM recurring_digest_reports").first()
        )
      ).toEqual({ total: 2 });
    })
  ));

it("excludes earlier-day backlog and permanently suppressed confirmations while retaining the first-discovery offer", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* proactivityDatabase;
      const context = yield* activateDigest(db);
      yield* seedRecurringDigestSource({
        ...context,
        confirmedAt: "2026-10-05T19:00:00Z",
        counterparty: "Anterior",
        index: 1,
      });
      yield* seedRecurringDigestSource({
        ...context,
        confirmedAt: "2026-10-06T19:00:00Z",
        counterparty: "Hoy",
        index: 2,
      });
      vi.spyOn(Date, "now").mockReturnValue(closedNow.epochMilliseconds);
      const id = yield* freezeDigest(db);
      expect(
        Option.getOrThrow(yield* findRecurringDigestReport({ ...context, id })).payload.items.map(
          (item) => item.counterparty
        )
      ).toEqual(["Hoy"]);

      const suppressedDb = yield* proactivityDatabase;
      const suppressed = { ...context, db: suppressedDb };
      yield* Effect.tryPromise(() =>
        suppressedDb.batch(
          [7, 8, 9].map((month) =>
            suppressedDb
              .prepare(
                "INSERT INTO transactions(id,user_id,amount,currency,direction,counterparty,category_id,occurred_at,created_at) VALUES(?,?,'100.00','COP','outflow','Suprimido','10000000-0000-4000-8000-000000000016',?,'2026-10-01T18:00:00Z')"
              )
              .bind(
                `29000000-0000-4000-8000-${String(month).padStart(12, "0")}`,
                context.userId,
                `2026-${String(month).padStart(2, "0")}-01T18:00:00Z`
              )
          )
        )
      );
      vi.spyOn(Date, "now").mockReturnValue(
        DateTime.makeUnsafe("2026-10-06T19:00:00Z").epochMilliseconds
      );
      yield* Effect.forEach(Array.from({ length: 12 }), () => evaluateRecurringSeries(suppressed), {
        discard: true,
      });
      vi.spyOn(Date, "now").mockReturnValue(closedNow.epochMilliseconds);
      yield* requestRecurringDigestOffer({
        ...suppressed,
        now: closedNow,
        messageId: "suppressed-discovery",
      });
      expect(
        yield* Effect.tryPromise(() =>
          suppressedDb
            .prepare(
              "SELECT count(*) AS total FROM proactivity_offer_requests WHERE kind='new-recurring-series'"
            )
            .first()
        )
      ).toEqual({ total: 1 });
      yield* activateDigest(suppressedDb);
      expect((yield* advanceRecurringDigest({ ...suppressed, now: closedNow }))._tag).toBe(
        "Progress"
      );
      expect(
        yield* Effect.tryPromise(() =>
          suppressedDb.prepare("SELECT count(*) AS total FROM recurring_digest_reports").first()
        )
      ).toEqual({ total: 0 });
      vi.spyOn(Date, "now").mockReturnValue(
        DateTime.makeUnsafe("2026-11-15T14:00:00Z").epochMilliseconds
      );
      expect(
        (yield* advanceRecurringDigest({
          ...suppressed,
          now: DateTime.makeUnsafe("2026-11-15T14:00:00Z"),
        }))._tag
      ).toBe("NoWork");
      expect(
        yield* Effect.tryPromise(() =>
          suppressedDb.prepare("SELECT count(*) AS total FROM recurring_digest_reports").first()
        )
      ).toEqual({ total: 0 });
    })
  ));

it("recovers recurring work independently through Maintenance, identity-only Queue and native Workflow", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* proactivityDatabase;
      const context = yield* activateDigest(db);
      yield* seedRecurringDigestSource({
        ...context,
        confirmedAt: "2026-10-06T19:00:00Z",
        counterparty: "Netflix",
        index: 1,
      });
      vi.spyOn(Date, "now").mockReturnValue(closedNow.epochMilliseconds);
      yield* setupDigestCoordinator(db);
      const published: ProactivityDeliveryWork[] = [];
      const unexpected = (): never => {
        throw new Error("Unexpected provider operation");
      };
      const instance: WorkflowInstance = {
        id: "recurring",
        pause: unexpected,
        resume: unexpected,
        terminate: unexpected,
        restart: unexpected,
        delete: unexpected,
        sendEvent: unexpected,
        subscribe: unexpected,
        status: () => Promise.resolve({ status: "running" }),
      };
      const create = vi
        .fn<Workflow<ProactivityDeliveryWork>["create"]>()
        .mockResolvedValue(instance);
      const workflow: Workflow<ProactivityDeliveryWork> = {
        create,
        get: unexpected,
        createBatch: unexpected,
        deleteBatch: unexpected,
      };
      const environment = {
        WEEKLY_DELIVERY_WORKFLOW: workflow,
        DB: db,
        PROACTIVITY_ENABLED: "enabled",
        KAPSO_API_KEY: "test-only",
        PROACTIVITY_TEMPLATE_JSON: yield* Schema.encodeEffect(
          Schema.fromJsonString(ProactivityTemplateConfiguration)
        )({ name: "fidy_proactivity", language: "es", approval: "approved", body: "Fidy: {{1}}" }),
        WEEKLY_DELIVERY_QUEUE: {
          send: (message: ProactivityDeliveryWork): Promise<QueueSendResponse> => {
            published.push(message);
            return Promise.resolve({
              metadata: { metrics: { backlogCount: published.length, backlogBytes: 0 } },
            });
          },
        },
      };
      const harness = proactivityWorkflowHarness({
        environment,
        userId: context.userId,
        otherUserIds: [],
        unavailableUserIds: [],
      });
      yield* harness.sweep();
      expect(published).toHaveLength(1);
      const work = yield* Schema.decodeUnknownEffect(ProactivityDeliveryWork)(published[0]);
      expect(Object.keys(work).sort()).toEqual(["id", "kind", "userId", "version"]);
      const bad = { body: { ...work, version: 2 }, ack: vi.fn(), retry: vi.fn() };
      yield* harness.receive({ messages: [bad], workflow: Option.some(workflow) });
      expect(create).not.toHaveBeenCalled();
      const message = { body: work, ack: vi.fn(), retry: vi.fn() };
      yield* harness.receive({ messages: [message], workflow: Option.some(workflow) });
      expect(message.ack).toHaveBeenCalledOnce();
      expect(create).toHaveBeenCalledOnce();
      externalProvider.mockResolvedValue(
        Response.json({ messaging_product: "whatsapp", messages: [{ id: "workflow-digest" }] })
      );
      const step: WorkflowStep = {
        do: makeExecutingWeeklyFixtureStep(),
        sleep: unexpected,
        sleepUntil: unexpected,
        waitForEvent: unexpected,
      };
      yield* Effect.tryPromise(() => harness.execute({ work, step }));
      yield* Effect.tryPromise(() => harness.execute({ work, step }));
      expect(externalProvider).toHaveBeenCalledOnce();
      yield* harness.sweep();
      expect(
        yield* Effect.tryPromise(() =>
          db.prepare("SELECT count(*) AS total FROM recurring_digest_reports").first()
        )
      ).toEqual({ total: 1 });
    })
  ));
