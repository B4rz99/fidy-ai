import type { Miniflare } from "miniflare";
import { NodeFileSystem } from "@effect/platform-node";
import { it } from "@effect/vitest";
import { Data, Effect, Schedule, Schema } from "effect";
import { expect } from "vitest";
import { alice, bob, seed } from "../financial-user-store.test-fixture";
import { native, nativeBillingPlatform } from "../user-store.test-fixture";
import { type LocalRefundWork, type RefundRead, type RefundSupportAdmission } from "./contract";

const RefundWire = Data.taggedEnum<
  typeof RefundSupportAdmission.Encoded | typeof RefundRead.Encoded | typeof LocalRefundWork.Encoded
>();

const attempt = "40000000-0000-4000-8000-000000000001";

const subscription = "40000000-0000-4000-8000-000000000002";

const price = "40000000-0000-4000-8000-000000000003";

const requestId = "50000000-0000-4000-8000-000000000001";

const submitTo =
  (ns: Awaited<ReturnType<Miniflare["getDurableObjectNamespace"]>>) =>
  (
    target: string,
    expiresAtMs: number,
    { amount = "4000", key = requestId, voidCard = false } = {}
  ): Effect.Effect<Response> =>
    Effect.gen(function* () {
      const data = RefundWire.BillingRefundSupport({
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
          intent: voidCard
            ? { kind: "card-void" }
            : { kind: "refund", money: { amount, currency: "COP" } },
        },
      });

      const response = yield* native(() =>
        ns.getByName(target).fetch("https://user.invalid/billing/refund-support", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(data),
        })
      );

      return new Response(yield* native(() => response.text()), { status: response.status });
    });

const runVoidStep = (
  users: Awaited<ReturnType<Miniflare["getDurableObjectNamespace"]>>,
  id: string
): ((verification: number, target?: string) => Effect.Effect<void>) =>
  Effect.fn(function* (verification: number, target: string = alice.user) {
    const response = yield* native(() =>
      users.getByName(target).fetch("https://user.invalid/work/refund", {
        method: "POST",
        body: JSON.stringify(
          RefundWire.RunUserRefund({ userId: alice.user, refundAttemptId: id, verification })
        ),
      })
    );

    expect(response.status).toBe(204);
  });

const paidOwner = Effect.fn(function* (runtime: Miniflare) {
  const owner = yield* seed(runtime, alice, false);
  yield* seed(runtime, bob, false);
  yield* owner.exec("INSERT INTO subscriptions(id,user_id) VALUES(?,?)", subscription, alice.user);
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

  return owner;
});

it.layer(NodeFileSystem.layer, { excludeTestServices: true })((test) => {
  test.effect(
    "binds sandbox refund acceptance, exact replay and bounded reservations to the original paid User",
    Effect.fnUntraced(function* () {
      const runtime = yield* (yield* nativeBillingPlatform)();

      const provider = yield* native(() =>
        runtime.unsafeGetDurableObjectStorage("wompi-fixture", "ProviderState", {
          name: "provider",
        })
      );

      yield* native(() =>
        provider.exec(
          "CREATE TABLE refund_requests(reference TEXT NOT NULL,amount INTEGER NOT NULL)"
        )
      );
      const owner = yield* paidOwner(runtime);
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
        yield* native(() => provider.exec("SELECT count(*) AS count FROM refund_requests"))
      ).toEqual([{ count: 1 }]);
      expect(
        yield* owner.exec(
          "SELECT count(*) AS count FROM subscription_renewal_fences WHERE user_id=?",
          alice.user
        )
      ).toEqual([{ count: 1 }]);

      const receipt = yield* native(() =>
        ns.getByName(alice.user).fetch("https://user.invalid/billing/refund-support", {
          method: "POST",
          body: JSON.stringify(
            RefundWire.ReadBillingRefund({
              authority: {
                operatorId: "operator",
                permission: "billing.refund",
                expiresAtMs: expires,
              },
              userId: alice.user,
              refundAttemptId: accepted.data.id,
            })
          ),
        })
      );

      const replayWork = RefundWire.RunUserRefund({
        userId: alice.user,
        refundAttemptId: accepted.data.id,
        verification: 0,
      });

      yield* Effect.forEach(
        [alice.user, bob.user],
        Effect.fnUntraced(function* (named) {
          const retry = yield* native(() =>
            ns.getByName(named).fetch("https://user.invalid/work/refund", {
              method: "POST",
              body: JSON.stringify(replayWork),
            })
          );

          expect(retry.status).toBe(204);
        }),
        { discard: true }
      );

      expect(
        yield* native(() => provider.exec("SELECT count(*) AS count FROM refund_requests"))
      ).toEqual([{ count: 1 }]);
      expect(yield* native(() => receipt.json())).toMatchObject({
        data: {
          id: accepted.data.id,
          status: "succeeded",
          money: { amount: "4000", currency: "COP" },
        },
      });
    })
  );
  test.effect(
    "a lost sandbox card-void response stays pending until exact read-only confirmation and never repeats the charge mutation",
    () =>
      Effect.gen(function* () {
        const runtime = yield* (yield* nativeBillingPlatform)(),
          owner = yield* paidOwner(runtime);

        const provider = yield* native(() =>
          runtime.unsafeGetDurableObjectStorage("wompi-fixture", "ProviderState", {
            name: "provider",
          })
        );

        yield* native(() =>
          provider.exec(
            "CREATE TABLE card_void_control(posts INTEGER,checks INTEGER,amount INTEGER,reference TEXT); INSERT INTO card_void_control VALUES(0,0,1,'foreign')"
          )
        );
        const users = yield* native(() => runtime.getDurableObjectNamespace("USER_STORE", "core"));
        const receipt = yield* submitTo(users)(alice.user, owner.now + 600000, { voidCard: true });
        expect(receipt.status).toBe(202);

        const accepted = yield* Schema.decodeUnknownEffect(
          Schema.Struct({ data: Schema.Struct({ id: Schema.String }) })
        )(yield* native(() => receipt.json()));

        const id = accepted.data.id;
        yield* owner
          .exec("SELECT id FROM refund_attempts WHERE id=? AND progress='outcome-unknown'", id)
          .pipe(
            Effect.filterOrFail(
              (rows) => rows.length === 1,
              () => "pending"
            ),
            Effect.retry({ times: 100, schedule: Schedule.spaced("60 millis") })
          );
        const run = runVoidStep(users, id);
        yield* run(0);
        yield* run(1, bob.user);
        yield* run(1);
        expect(
          yield* owner.exec(
            "SELECT status,verified_status,verification_attempts FROM refund_attempts WHERE id=?",
            id
          )
        ).toEqual([{ status: "pending", verified_status: null, verification_attempts: 1 }]);
        expect(
          yield* native(() => provider.exec("SELECT posts,checks FROM card_void_control"))
        ).toEqual([{ posts: 1, checks: 1 }]);
        yield* native(() =>
          provider.exec(
            "UPDATE card_void_control SET amount=1000000,reference=?",
            "fidy-" + attempt
          )
        );
        yield* run(1);
        yield* run(2);
        yield* run(2);
        yield* run(0);
        expect(
          yield* owner.exec(
            "SELECT status,verified_status,verification_attempts FROM refund_attempts WHERE id=?",
            id
          )
        ).toEqual([{ status: "succeeded", verified_status: "VOIDED", verification_attempts: 2 }]);
        expect(
          yield* native(() => provider.exec("SELECT posts,checks FROM card_void_control"))
        ).toEqual([{ posts: 1, checks: 2 }]);
      })
  );
});
