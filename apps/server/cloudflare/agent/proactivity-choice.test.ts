import { afterAll, expect, it } from "vitest";
import { DateTime, Effect, Option, Schema } from "effect";
import {
  createProactivityConsentOffer,
  findProactivityConsentGrant,
  recordProactivityConsentDisclosure,
} from "../consent/operations";
import { findReminderSchedule } from "../insights/operations";
import {
  proactivityDatabase,
  proactivityTestCallers,
  proactivityTestDatabases,
  proactivityTestUsers,
  withdrawTestProcessingConsent,
} from "../proactivity.test-fixture";
import { approvedWorkersAiModel } from "../../src/shell/hosted-inference/contract";
import { WhatsAppTurnAdmission } from "../whatsapp/contract";
import { makeAgentService } from "./runtime";

afterAll(() => proactivityTestDatabases.dispose());
it("an authenticated reminder request creates a contextual offer without inference or implied opt-in", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* proactivityDatabase;
      const now = yield* DateTime.now;
      const service = makeAgentService({
        userId: proactivityTestUsers[0],
        environment: {
          DB: db,
          AI: { run: (): Promise<never> => Promise.reject(new Error("Offer must not infer")) },
          HOSTED_AI_MODEL: approvedWorkersAiModel,
        },
        scheduleRecovery: () => Promise.resolve(),
      });
      const admission = yield* Schema.decodeEffect(WhatsAppTurnAdmission)({
        userId: proactivityTestUsers[0],
        portfolioId: proactivityTestCallers[0].businessPortfolioId,
        bsuid: proactivityTestCallers[0].businessScopedUserId,
        businessPhoneNumberId: "123456789",
        messageId: "request-reminders",
        occurredAtMs: now.epochMilliseconds,
        receivedAtMs: now.epochMilliseconds,
        text: "activar recordatorios",
      });
      const body = yield* Schema.encodeEffect(
        Schema.fromJsonString(Schema.toCodecJson(WhatsAppTurnAdmission))
      )(admission);
      const request = new Request("https://coordinator/hosted-turn/whatsapp", {
        method: "POST",
        body,
      });
      const response = yield* Effect.tryPromise(
        () => Option.getOrThrow(service.accept({ request, preceding: Promise.resolve() })).response
      );
      expect(response.status).toBe(202);
      expect(
        Option.isNone(
          yield* findProactivityConsentGrant({
            db,
            userId: admission.userId,
            kind: "manual-entry-reminder",
          })
        )
      ).toBe(true);
      expect(
        yield* Effect.tryPromise(() =>
          db
            .prepare(
              "SELECT count(*) AS n FROM proactivity_offer_requests WHERE user_id=? AND kind='manual-entry-reminder'"
            )
            .bind(admission.userId)
            .first()
        )
      ).toEqual({ n: 1 });
    })
  ));

it.each(["budget-threshold", "manual-entry-reminder", "new-recurring-series"] as const)(
  "routes exact authenticated %s choices before model execution, retaining replay receipts without extra legal events",
  (kind) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const db = yield* proactivityDatabase;
        const now = DateTime.nowUnsafe();
        const context = {
          db,
          userId: proactivityTestUsers[0],
          caller: proactivityTestCallers[0],
          kind,
          now,
        };
        const offer = Option.getOrThrow(yield* createProactivityConsentOffer(context));
        yield* recordProactivityConsentDisclosure({
          ...context,
          offerId: offer.id,
          disclosureMessageId: "offer-disclosed",
        });
        const service = makeAgentService({
          userId: context.userId,
          environment: {
            DB: db,
            AI: {
              run: (): Promise<never> =>
                Promise.reject(new Error("Consent choice must not invoke inference")),
            },
            HOSTED_AI_MODEL: approvedWorkersAiModel,
          },
          scheduleRecovery: (): Promise<void> => Promise.resolve(),
        });
        const admission = yield* Schema.decodeEffect(WhatsAppTurnAdmission)({
          userId: context.userId,
          portfolioId: context.caller.businessPortfolioId,
          bsuid: context.caller.businessScopedUserId,
          businessPhoneNumberId: "123456789",
          messageId: "accepted-choice",
          occurredAtMs: now.epochMilliseconds,
          receivedAtMs: now.epochMilliseconds,
          text: offer.acceptChoice,
        });
        for (const rejected of [
          { ...admission, text: "proactivity:malformed", messageId: "malformed-choice" },
          {
            ...admission,
            bsuid: proactivityTestCallers[1].businessScopedUserId,
            messageId: "foreign-choice",
          },
          {
            ...admission,
            text: offer.acceptChoice.replace(
              kind,
              kind === "budget-threshold" ? "manual-entry-reminder" : "budget-threshold"
            ),
            messageId: "substituted-category",
          },
        ]) {
          const candidate = yield* Schema.decodeUnknownEffect(Schema.toType(WhatsAppTurnAdmission))(
            rejected
          );
          const encoded = yield* Schema.encodeEffect(
            Schema.fromJsonString(Schema.toCodecJson(WhatsAppTurnAdmission))
          )(candidate);
          const failed = Option.getOrThrow(
            service.accept({
              request: new Request("https://coordinator/hosted-turn/whatsapp", {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: encoded,
              }),
              preceding: Promise.resolve(),
            })
          );
          expect((yield* Effect.tryPromise(() => failed.response)).status).not.toBe(200);
          yield* Effect.tryPromise(() => failed.settled);
          expect(Option.isNone(yield* findProactivityConsentGrant(context))).toBe(true);
          expect(Option.isNone(yield* findReminderSchedule(context))).toBe(true);
        }
        const body = yield* Schema.encodeEffect(
          Schema.fromJsonString(Schema.toCodecJson(WhatsAppTurnAdmission))
        )(admission);
        for (let retry = 0; retry < 2; retry += 1) {
          const work = Option.getOrThrow(
            service.accept({
              request: new Request("https://coordinator/hosted-turn/whatsapp", {
                method: "POST",
                headers: { "content-type": "application/json" },
                body,
              }),
              preceding: Promise.resolve(),
            })
          );
          expect((yield* Effect.tryPromise(() => work.response)).status).toBe(200);
          yield* Effect.tryPromise(() => work.settled);
        }
        expect(Option.isSome(yield* findProactivityConsentGrant(context))).toBe(true);
        expect(Option.isSome(yield* findReminderSchedule(context))).toBe(
          kind === "manual-entry-reminder"
        );
        expect(
          yield* Effect.tryPromise(() =>
            db
              .prepare(
                "SELECT count(*) AS n FROM proactivity_consent_records WHERE user_id=? AND kind=?"
              )
              .bind(context.userId, kind)
              .first()
          )
        ).toEqual({ n: 1 });
        yield* withdrawTestProcessingConsent(db);
        const revocation = yield* Schema.decodeUnknownEffect(Schema.toType(WhatsAppTurnAdmission))({
          ...admission,
          text: offer.revokeChoice,
          messageId: "revoke-choice",
        });
        const revoke = yield* Schema.encodeEffect(
          Schema.fromJsonString(Schema.toCodecJson(WhatsAppTurnAdmission))
        )(revocation);
        const withdrawal = Option.getOrThrow(
          service.accept({
            request: new Request("https://coordinator/hosted-turn/whatsapp", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: revoke,
            }),
            preceding: Promise.resolve(),
          })
        );
        expect((yield* Effect.tryPromise(() => withdrawal.response)).status).toBe(200);
        yield* Effect.tryPromise(() => withdrawal.settled);
        expect(Option.isNone(yield* findProactivityConsentGrant(context))).toBe(true);
        expect(
          yield* Effect.tryPromise(() =>
            db
              .prepare("SELECT count(*) AS n FROM hosted_turns WHERE user_id=?")
              .bind(context.userId)
              .first()
          )
        ).toEqual({ n: 0 });
      })
    )
);
