import type { Miniflare } from "miniflare";
import { NodeFileSystem } from "@effect/platform-node";
import { it } from "@effect/vitest";
import { Effect, Schedule, Schema } from "effect";
import { expect } from "vitest";
import { alice, bob, seed } from "../financial-user-store.test-fixture";
import { native, nativeBillingPlatform } from "../user-store.test-fixture";

const attempt = "40000000-0000-4000-8000-000000000001";
const subscription = "40000000-0000-4000-8000-000000000002";
const price = "40000000-0000-4000-8000-000000000003";
const requestId = "50000000-0000-4000-8000-000000000001";
const submitTo =
  (ns: Awaited<ReturnType<Miniflare["getDurableObjectNamespace"]>>) =>
  (
    target: string,
    expiresAtMs: number,
    { amount = "4000", key = requestId } = {}
  ): Effect.Effect<Response> =>
    Effect.gen(function* () {
      const data = {
        _tag: "BillingRefundSupport",
        authority: {
          operatorId: "refund-reviewer",
          permission: "billing.refund",
          expiresAtMs,
        },
        input: {
          userId: alice.user,
          billingAttemptId: attempt,
          requestId: key,
          reason: "user-request",
          intent: { kind: "refund", money: { amount, currency: "COP" } },
        },
      };
      const response = yield* native(() =>
        ns.getByName(target).fetch("https://user.invalid/billing/refund-support", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(data),
        })
      );
      return new Response(yield* native(() => response.text()), { status: response.status });
    });
it.layer(NodeFileSystem.layer, { excludeTestServices: true })((test) => {
  test.effect(
    "binds sandbox refund acceptance, exact replay and bounded reservations to the original paid User",
    () =>
      Effect.gen(function* () {
        const runtime = yield* (yield* nativeBillingPlatform)();
        const provider = yield* native(() =>
          runtime.getD1Database("PROVIDER_STATE", "wompi-fixture")
        );
        yield* native(() =>
          provider
            .prepare(
              "CREATE TABLE refund_requests(reference TEXT NOT NULL,amount INTEGER NOT NULL)"
            )
            .run()
        );
        const owner = yield* seed(runtime, alice, false);
        yield* seed(runtime, bob, false);
        yield* owner.exec(
          "INSERT INTO subscriptions(id,user_id) VALUES(?,?)",
          subscription,
          alice.user
        );
        yield* owner.exec(
          "INSERT INTO payment_sources(id,subscription_id,billing_email,method,wompi_environment,wompi_source_id) VALUES('src',?,'payer@example.test','card','sandbox',5101)",
          subscription
        );
        yield* owner.exec(
          "INSERT INTO billing_attempts(id,subscription_id,payment_source_id,wompi_environment,wompi_reference,amount,currency,billing_period,time_zone,collection_state,status,paid_starts_at_ms,paid_ends_at_ms,price_terms) VALUES(?,?,'src','sandbox',?,'10000','COP','monthly','America/Bogota','sent','succeeded',?,?,json_object('id',?,'serviceMarket','CO','taxTreatment','not-taxable'))",
          attempt,
          subscription,
          "fidy-" + attempt,
          owner.now,
          owner.now + 86400000,
          price
        );
        yield* owner.exec(
          "INSERT INTO billing_provider_transactions(transaction_id,attempt_id,status,first_observed_at_ms,finalized_at_ms) VALUES('12345-1000000000-12345',?,'APPROVED',?,?)",
          attempt,
          owner.now,
          owner.now
        );
        const ns = yield* native(() => runtime.getDurableObjectNamespace("USER_STORE", "core"));
        const submit = submitTo(ns);
        const expires = owner.now + 600000;
        expect((yield* submit(bob.user, expires)).status).toBe(403);
        expect((yield* submit(alice.user, owner.now - 1)).status).toBe(403);
        const [first, replay] = yield* Effect.all(
          [submit(alice.user, expires), submit(alice.user, expires)],
          { concurrency: 2 }
        );
        expect(first.status).toBe(202);
        expect(replay.status).toBe(202);
        const accepted = yield* Schema.decodeUnknownEffect(
          Schema.Struct({ data: Schema.Struct({ id: Schema.String, status: Schema.String }) })
        )(yield* native(() => first.json()));
        expect(yield* native(() => replay.json())).toMatchObject({
          data: { id: accepted.data.id },
        });
        expect((yield* submit(alice.user, expires, { amount: "5000" })).status).toBe(409);
        expect((yield* submit(alice.user, expires, { amount: "8000", key: bob.user })).status).toBe(
          409
        );
        expect(
          yield* owner.exec(
            "SELECT user_id,request_id,amount_in_cents FROM refund_attempts WHERE request_id IS NOT NULL"
          )
        ).toEqual([{ user_id: alice.user, request_id: requestId, amount_in_cents: 400000 }]);
        yield* owner
          .exec(
            "SELECT status FROM refund_attempts WHERE id=? AND status='succeeded'",
            accepted.data.id
          )
          .pipe(
            Effect.filterOrFail(
              (rows) => rows.length === 1,
              () => "waiting for verification"
            ),
            Effect.retry({ times: 100, schedule: Schedule.spaced("60 millis") })
          );
        expect(
          yield* native(() =>
            provider.prepare("SELECT count(*) AS count FROM refund_requests").first()
          )
        ).toEqual({ count: 1 });
        expect(
          yield* owner.exec(
            "SELECT count(*) AS count FROM subscription_renewal_fences WHERE user_id=?",
            alice.user
          )
        ).toEqual([{ count: 1 }]);
        const receipt = yield* native(() =>
          ns.getByName(alice.user).fetch("https://user.invalid/billing/refund-support", {
            method: "POST",
            body: JSON.stringify({
              _tag: "ReadBillingRefund",
              authority: {
                operatorId: "operator",
                permission: "billing.refund",
                expiresAtMs: expires,
              },
              userId: alice.user,
              refundAttemptId: accepted.data.id,
            }),
          })
        );
        const replayWork = {
          _tag: "RunUserRefund",
          userId: alice.user,
          refundAttemptId: accepted.data.id,
          verification: 0,
        };
        for (const named of [alice.user, bob.user]) {
          const retry = yield* native(() =>
            ns.getByName(named).fetch("https://user.invalid/work/refund", {
              method: "POST",
              body: JSON.stringify(replayWork),
            })
          );
          expect(retry.status).toBe(204);
        }
        expect(
          yield* native(() =>
            provider.prepare("SELECT count(*) AS count FROM refund_requests").first()
          )
        ).toEqual({ count: 1 });
        expect(yield* native(() => receipt.json())).toMatchObject({
          data: {
            id: accepted.data.id,
            status: "succeeded",
            money: { amount: "4000", currency: "COP" },
          },
        });
      })
  );
});
