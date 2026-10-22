import { DateTime, Effect, Option } from "effect";
import { afterAll, afterEach, expect, it, vi } from "vitest";
import { installTestSchema, isolatedTestDatabases } from "../d1-test-fixture";
import { seedRefundCharge } from "./refund-charge.test-fixture";
import { startRefund } from "./operations";
import { runRefundWorkflow } from "./runtime";
import { acceptWhatsAppMedia } from "../ingestion/operations";
import { readQuotaStatus } from "../quotas/operations";
import {
  UserId,
  WhatsAppBusinessPortfolioId,
  WhatsAppBusinessScopedUserId,
} from "../../src/core/identity/contract";
import {
  WhatsAppBusinessPhoneNumberId,
  type WhatsAppInboundEvent,
  WhatsAppMediaId,
  WhatsAppProviderMessageId,
} from "../../src/shell/channels/whatsapp/contract";

const databases = isolatedTestDatabases();
afterAll(() => databases.dispose());
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
const io = <A>(run: () => Promise<A>): Effect.Effect<A> =>
  Effect.tryPromise(run).pipe(Effect.orDie);
const userId = UserId.make("10000000-0000-4000-8000-000000000001");
const current = Date.parse("2026-07-15T12:00:00.000Z");
const nextPeriod = Date.parse("2026-08-01T05:00:00.000Z");
const event = (id: string, at: number): WhatsAppInboundEvent => ({
  caller: {
    businessPortfolioId: WhatsAppBusinessPortfolioId.make("portfolio"),
    businessScopedUserId: WhatsAppBusinessScopedUserId.make("CO.actor"),
    parentBusinessScopedUserId: Option.none(),
    username: Option.none(),
    phoneNumber: Option.none(),
  },
  businessPhoneNumberId: WhatsAppBusinessPhoneNumberId.make("123"),
  messageEvidence: {
    channel: "whatsapp",
    provider: "kapso",
    providerMessageId: WhatsAppProviderMessageId.make(id),
  },
  occurredAt: DateTime.makeUnsafe(current),
  receivedAt: DateTime.makeUnsafe(at),
  replyToMessageId: Option.none(),
  content: { _tag: "Image", mediaId: WhatsAppMediaId.make(`media-${id}`), caption: Option.none() },
});

const authorizeMedia = (db: D1Database): Effect.Effect<void> =>
  io(() =>
    db.batch([
      db
        .prepare(
          "UPDATE users SET whatsapp_portfolio_id='portfolio',whatsapp_bsuid='CO.actor',whatsapp_verified_at_ms=1 WHERE id=?"
        )
        .bind(userId),
      db
        .prepare(
          "INSERT INTO consent_history(record_type,id,user_id,disclosure_json,disclosure_message_id,decision_message_id,decision_received_at_ms,occurred_at_ms) VALUES('processing_grant','90000000-0000-4000-8000-000000000001',?,'{}','disclosed','accepted',1,1)"
        )
        .bind(userId),
    ])
  ).pipe(Effect.asVoid);

it("keeps original media accounting across verified paid-access correction, concurrent Free admission and a period boundary", () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  return Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* io(() => databases.acquire());
      yield* io(() => installTestSchema({ db }));
      yield* seedRefundCharge(db);
      yield* authorizeMedia(db);
      vi.setSystemTime(current);
      const admit = (identity: string, at = current): Effect.Effect<Response> =>
        acceptWhatsAppMedia({ db, userId, event: event(identity, at) });
      for (const identity of ["pro-one", "pro-two", "pro-three"]) {
        expect((yield* admit(identity)).status).toBe(202);
      }
      expect(
        Option.getOrThrow(yield* readQuotaStatus({ db, userId, current })).mediaSubmissions
      ).toEqual({ _tag: "Uncapped" });
      const original = yield* io(() =>
        db
          .prepare(
            "SELECT identity,period_start_ms,accepted_at_ms,units FROM commercial_allowance_consumptions ORDER BY identity"
          )
          .all()
      );
      expect(original.results.map((row) => row.units)).toEqual([0, 0, 0]);
      const refund = yield* startRefund({
        db,
        environment: "sandbox",
        authority: {
          operatorId: "support",
          permission: "billing.refund",
          expiresAtMs: current + 60000,
        },
        input: {
          userId,
          billingAttemptId: "40000000-0000-4000-8000-000000000001",
          requestId: "80000000-0000-4000-8000-000000000001",
          intent: { kind: "refund", money: { amount: "4000", currency: "COP" } },
          reason: "user-request",
        },
      });
      vi.setSystemTime(current + 1);
      vi.stubGlobal("fetch", () =>
        Promise.resolve(
          Response.json(
            {
              data: {
                id: 1523,
                v2_refund_id: "verified-refund",
                status: "APPROVED",
                transaction_id: "provider-charge",
                amount_in_cents: 400000,
                reference: `fidy-refund-${refund.id}`,
              },
            },
            { status: 201 }
          )
        )
      );
      yield* io(() =>
        runRefundWorkflow({
          environment: {
            DB: db,
            WOMPI_ENVIRONMENT: "sandbox",
            WOMPI_PUBLIC_KEY: `pub_test_${"f1d7c0de".repeat(3)}`,
            WOMPI_PRIVATE_KEY: `prv_test_${"f1d7c0de".repeat(3)}`,
            WOMPI_INTEGRITY_SECRET: `test_integrity_${"f1d7c0de".repeat(3)}`,
          },
          payload: { version: 1, kind: "refund", refundAttemptId: refund.id },
          activity: (_name, _options, run) => run(),
        })
      );
      expect(
        Option.getOrThrow(yield* readQuotaStatus({ db, userId, current: current + 1 }))
          .mediaSubmissions
      ).toMatchObject({ _tag: "Limited", consumed: 0, remaining: 2 });
      expect((yield* admit("pro-one", current + 1)).status).toBe(202);
      expect((yield* admit("free-one", current + 1)).status).toBe(202);
      const competing = yield* Effect.all(
        [admit("free-two", current + 1), admit("free-three", current + 1)],
        { concurrency: "unbounded" }
      );
      expect(
        competing.map((response) => response.status).sort((left, right) => left - right)
      ).toEqual([202, 429]);
      expect(
        Option.getOrThrow(yield* readQuotaStatus({ db, userId, current: current + 1 }))
          .mediaSubmissions
      ).toMatchObject({ consumed: 2, remaining: 0 });
      vi.setSystemTime(nextPeriod);
      expect((yield* admit("pro-one", nextPeriod)).status).toBe(202);
      expect((yield* admit("free-one", nextPeriod)).status).toBe(202);
      expect(
        Option.getOrThrow(yield* readQuotaStatus({ db, userId, current: nextPeriod }))
          .mediaSubmissions
      ).toMatchObject({ consumed: 0, remaining: 2 });
      expect((yield* admit("new-period", nextPeriod)).status).toBe(202);
      expect(
        Option.getOrThrow(yield* readQuotaStatus({ db, userId, current: nextPeriod }))
          .mediaSubmissions
      ).toMatchObject({ consumed: 1, remaining: 1 });
      const retained = yield* io(() =>
        db
          .prepare(
            "SELECT identity,period_start_ms,accepted_at_ms,units FROM commercial_allowance_consumptions WHERE units=0 ORDER BY identity"
          )
          .all()
      );
      expect(retained.results).toEqual(original.results);
      expect((yield* io(() => db.prepare("PRAGMA foreign_key_check").all())).results).toEqual([]);
    })
  );
});

it("ends an original Trial at its exclusive boundary without charging retained Trial media", () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  return Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* io(() => databases.acquire());
      yield* io(() => installTestSchema({ db }));
      yield* io(() =>
        db
          .prepare(
            "INSERT INTO users(id,service_market,locale,time_zone,created_at_ms,trial_started_at_ms,trial_ends_at_ms) VALUES(?,'CO','es-CO','America/Bogota',0,?,?)"
          )
          .bind(userId, current + 1 - 604800000, current + 1)
          .run()
      );
      yield* authorizeMedia(db);
      vi.setSystemTime(current);
      for (const identity of ["trial-one", "trial-two", "trial-three"]) {
        expect(
          (yield* acceptWhatsAppMedia({ db, userId, event: event(identity, current) })).status
        ).toBe(202);
      }
      expect(
        Option.getOrThrow(yield* readQuotaStatus({ db, userId, current })).mediaSubmissions
      ).toEqual({ _tag: "Uncapped" });
      vi.setSystemTime(current + 1);
      expect(
        Option.getOrThrow(yield* readQuotaStatus({ db, userId, current: current + 1 }))
          .mediaSubmissions
      ).toMatchObject({ _tag: "Limited", consumed: 0, remaining: 2 });
      expect(
        (yield* acceptWhatsAppMedia({ db, userId, event: event("trial-one", current + 1) })).status
      ).toBe(202);
      expect(
        (yield* acceptWhatsAppMedia({ db, userId, event: event("free-after-trial", current + 1) }))
          .status
      ).toBe(202);
      expect(
        Option.getOrThrow(yield* readQuotaStatus({ db, userId, current: current + 1 }))
          .mediaSubmissions
      ).toMatchObject({ consumed: 1, remaining: 1 });
      expect(
        (yield* io(() =>
          db
            .prepare(
              "SELECT units,COUNT(*) AS count FROM commercial_allowance_consumptions GROUP BY units ORDER BY units"
            )
            .all()
        )).results
      ).toEqual([
        { units: 0, count: 3 },
        { units: 1, count: 1 },
      ]);
    })
  );
});
