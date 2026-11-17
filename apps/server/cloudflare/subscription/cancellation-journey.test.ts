import { NodeFileSystem } from "@effect/platform-node";
import { it } from "@effect/vitest";
import { Clock, Effect, Schedule } from "effect";
import { expect } from "vitest";
import type { Miniflare } from "miniflare";
import { native, nativeBillingPlatform } from "../user-store.test-fixture";

const user = "22370000-0000-4000-8000-000000000001";
const subscription = "22370000-0000-4000-8000-000000000002";
const source = "22370000-0000-4000-8000-000000000003";
const attempt = "22370000-0000-4000-8000-000000000004";

const paidUser = Effect.fnUntraced(function* (runtime: Miniflare) {
  const owner = yield* native(() =>
    runtime.getDurableObjectNamespace("USER_STORE", "core").then((ns) => ns.getByName(user))
  );
  const check = (): Effect.Effect<Awaited<ReturnType<typeof owner.fetch>>> =>
    native(() => owner.fetch("https://owner.internal/work/check", { method: "POST" }));
  expect((yield* check()).status).toBe(200);
  const store = yield* native(() =>
    runtime.unsafeGetDurableObjectStorage("core", "UserStore", { name: user })
  );
  const exec = (
    ...args: Parameters<typeof store.exec>
  ): Effect.Effect<Awaited<ReturnType<typeof store.exec>>> => native(() => store.exec(...args));
  const now = yield* Clock.currentTimeMillis;
  const provider = yield* native(() => runtime.getD1Database("PROVIDER_STATE", "wompi-fixture"));
  yield* native(() =>
    provider.prepare("CREATE TABLE received_voids(source INTEGER NOT NULL)").run()
  );
  yield* exec(
    "INSERT INTO users(id,service_market,locale,time_zone,created_at_ms) VALUES (?,'CO','es-CO','America/Bogota',0)",
    user
  );
  yield* exec("INSERT INTO subscriptions(id,user_id) VALUES (?,?)", subscription, user);
  yield* exec(
    "INSERT INTO payment_sources(id,subscription_id,method,wompi_environment,wompi_source_id) VALUES (?,?,'daviplata','sandbox',78001)",
    source,
    subscription
  );
  yield* exec(
    "INSERT INTO billing_attempts(id,subscription_id,payment_source_id,paid_starts_at_ms,paid_ends_at_ms,wompi_environment) VALUES (?,?,?,1,?,'sandbox')",
    attempt,
    subscription,
    source,
    now + 3600000
  );
  yield* exec(
    "UPDATE subscriptions SET current_paid_attempt_id=? WHERE id=?",
    attempt,
    subscription
  );
  return { exec, check, provider, now };
});

it.layer(NodeFileSystem.layer, { excludeTestServices: true })((test) => {
  test.effect(
    "a cold User's missed cancellation handoff reaches its verified outcome through the real billing Queue and Workflow",
    () =>
      Effect.gen(function* () {
        const start = yield* nativeBillingPlatform;
        const runtime = yield* start();
        const { exec, check, provider, now } = yield* paidUser(runtime);
        // Interrupted after commit, with all native alarm retries exhausted.
        yield* exec(
          "INSERT INTO subscription_cancellations(paid_attempt_id,subscription_id,payment_source_id,cancelled_at_ms,paid_through_ms,source_cancellation_state,next_offer_at_ms) VALUES (?,?,?,?,?,'void-pending',?)",
          attempt,
          subscription,
          source,
          now,
          now + 3600000,
          now
        );
        const response = yield* check();
        expect(yield* native(() => response.json())).toEqual({
          attempted: 1,
          failedFamilies: 0,
          failedOffers: 0,
        });
        const settled = Effect.gen(function* () {
          const state = yield* exec(
            "SELECT source_cancellation_state FROM subscription_cancellations WHERE paid_attempt_id=?",
            attempt
          );
          return state[0]?.["source_cancellation_state"] === "voided";
        });
        yield* settled.pipe(
          Effect.repeat({
            until: (confirmed) => confirmed,
            schedule: Schedule.spaced("50 millis"),
          }),
          Effect.timeout("12 seconds")
        );
        const [evidence] = yield* exec(
          "SELECT void_started_at_ms,void_verified_at_ms,verification_count,next_offer_at_ms FROM subscription_cancellations"
        );
        expect(typeof evidence?.["void_started_at_ms"]).toBe("number");
        expect(typeof evidence?.["void_verified_at_ms"]).toBe("number");
        expect(evidence).toMatchObject({
          verification_count: 1,
          next_offer_at_ms: null,
        });
        expect(
          yield* native(() =>
            provider.prepare("SELECT COUNT(*) AS total FROM received_voids").first()
          )
        ).toEqual({ total: 1 });
      }),
    25000
  );
});
