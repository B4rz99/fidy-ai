import { NodeFileSystem } from "@effect/platform-node";
import { it } from "@effect/vitest";
import { Clock, DateTime, Effect, Schedule } from "effect";
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

  expect((yield* check()).status).toBe(204);

  const store = yield* native(() =>
    runtime.unsafeGetDurableObjectStorage("core", "UserStore", { name: user })
  );

  const exec = (
    ...args: Parameters<typeof store.exec>
  ): Effect.Effect<Awaited<ReturnType<typeof store.exec>>> => native(() => store.exec(...args));

  const now = yield* Clock.currentTimeMillis;

  const provider = yield* native(() =>
    runtime.unsafeGetDurableObjectStorage("wompi-fixture", "ProviderState", { name: "provider" })
  );

  yield* native(() => provider.exec("CREATE TABLE received_voids(source INTEGER NOT NULL)"));
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

const verified = Effect.fnUntraced(function* (paid: Effect.Success<ReturnType<typeof paidUser>>) {
  const { exec } = paid;

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
});

const routePAT = Effect.fnUntraced(function* (
  runtime: Miniflare,
  paid: Effect.Success<ReturnType<typeof paidUser>>
) {
  const id = "22370000-0000-4000-8000-000000000005";
  const short = "abcdefgh";
  const bearer = "fin_" + short + "_" + "x".repeat(43);

  const digest = yield* native(() =>
    crypto.subtle.digest("SHA-256", new TextEncoder().encode(bearer))
  );

  const expires = paid.now + 604800000;
  yield* paid.exec(
    "INSERT INTO pats(id,user_id,short_id,bearer_digest,recipient_label,scopes_json,lifetime_days,created_at_ms,issued_at_ms,expires_at_ms,request_id) VALUES (?,?,?,?,'agent',?,7,?,?,?,?)",
    id,
    user,
    short,
    digest,
    '["write"]',
    paid.now,
    paid.now,
    expires,
    id
  );

  const directory = yield* native(() =>
    runtime.unsafeGetDurableObjectStorage("core", "Directory", { name: "directory-v1" })
  );

  yield* native(() =>
    runtime
      .getDurableObjectNamespace("DIRECTORY", "core")
      .then((ns) =>
        ns.getByName("directory-v1").fetch("https://directory.internal/initialize-fixture")
      )
  );
  yield* native(() =>
    directory.exec("INSERT INTO pat_routes VALUES (?,?,?,?,?)", short, user, id, id, expires)
  );

  return (key: string): Effect.Effect<Awaited<ReturnType<Miniflare["dispatchFetch"]>>> =>
    native(() =>
      runtime.dispatchFetch("https://api.fidyapp.com/subscription/cancellation", {
        method: "POST",
        headers: {
          authorization: "Bearer " + bearer,
          "Fidy-Retry-Key": key,
          "CF-Connecting-IP": "192.0.2.1",
        },
      })
    );
});

it.layer(NodeFileSystem.layer, { excludeTestServices: true })((test) => {
  test.effect(
    "canonical cancellation seals a replayable receipt with its Audit and the User's recoverable intent",
    () =>
      Effect.gen(function* () {
        const start = yield* nativeBillingPlatform;
        const runtime = yield* start();
        const paid = yield* paidUser(runtime);
        const cancel = yield* routePAT(runtime, paid);
        const key = "22370000-0000-4000-8000-000000000006";
        yield* paid.exec("UPDATE payment_sources SET method=NULL WHERE id=?", source);
        expect((yield* cancel(key)).status).toBe(503);
        yield* paid.exec("UPDATE payment_sources SET method='daviplata' WHERE id=?", source);
        yield* paid.exec(
          "CREATE TRIGGER interrupt_receipt BEFORE INSERT ON canonical_request_receipts BEGIN SELECT RAISE(ABORT,'unavailable'); END"
        );
        expect((yield* cancel(key)).status).toBe(503);
        expect(
          yield* paid.exec("SELECT COUNT(*) AS count FROM subscription_cancellations")
        ).toEqual([{ count: 0 }]);
        expect(yield* paid.exec("SELECT COUNT(*) AS count FROM audit_entries")).toEqual([
          { count: 0 },
        ]);
        yield* paid.exec("DROP TRIGGER interrupt_receipt");
        const response = yield* cancel(key);
        expect(response.status).toBe(200);
        const accepted = yield* native(() => response.json());
        expect(accepted).toMatchObject({ data: { sourceCancellation: "void-pending" } });
        yield* verified(paid);
        const replay = yield* cancel(key);
        expect(replay.status).toBe(200);
        expect(yield* native(() => replay.json())).toEqual(accepted);
        expect(
          yield* paid.exec(
            "SELECT operation, COUNT(*) AS count FROM canonical_request_receipts GROUP BY operation"
          )
        ).toEqual([{ operation: "subscription.cancelSubscription", count: 1 }]);
        yield* paid.exec("UPDATE pats SET revoked_at_ms=? WHERE short_id='abcdefgh'", paid.now + 1);
        expect((yield* cancel(key)).status).toBe(401);
      })
  );
  test.effect(
    "a browser cancellation detaches the card and preserves the paid-through instant",
    () =>
      Effect.gen(function* () {
        const start = yield* nativeBillingPlatform;
        const runtime = yield* start();
        const paid = yield* paidUser(runtime);
        yield* paid.exec("UPDATE payment_sources SET method='card' WHERE id=?", source);
        const bearer = "1".repeat(43);
        const session = "22370000-0000-4000-8000-000000000007";

        const digest = yield* native(() =>
          crypto.subtle.digest("SHA-256", new TextEncoder().encode(bearer))
        );

        const expires = paid.now + 3600000;

        const cancel = (): Effect.Effect<Awaited<ReturnType<Miniflare["dispatchFetch"]>>> =>
          native(() =>
            runtime.dispatchFetch("https://api.fidyapp.com/subscription/cancellation", {
              method: "POST",
              headers: {
                origin: "https://app.fidyapp.com",
                "Fidy-Session-Binding": session,
                cookie: "__Host-fidy_session=" + bearer,
              },
            })
          );

        expect((yield* cancel()).status).toBe(401);

        const directory = yield* native(() =>
          runtime.unsafeGetDurableObjectStorage("core", "Directory", { name: "directory-v1" })
        );

        yield* native(() =>
          directory.exec(
            "INSERT INTO session_routes VALUES (?,?,?,?,?)",
            digest,
            user,
            session,
            "route-" + session,
            expires
          )
        );
        yield* paid.exec(
          "INSERT INTO web_sessions(id,pairing_id,user_id,token_digest,created_at_ms,fresh_until_ms,idle_expires_at_ms,hard_expires_at_ms) VALUES (?,?,?,?,?,?,?,?)",
          session,
          session,
          user,
          digest,
          paid.now,
          paid.now + 600000,
          expires,
          paid.now + 7776000000
        );
        const response = yield* cancel();
        expect(response.status).toBe(200);
        expect(yield* native(() => response.json())).toMatchObject({
          data: {
            sourceCancellation: "detached",
            paidThrough: DateTime.formatIso(DateTime.makeUnsafe(expires)),
          },
        });
      })
  );
  test.effect(
    "duplicate Queue delivery restarts the failed cancellation Workflow and the User verifies one source void",
    () =>
      Effect.gen(function* () {
        const start = yield* nativeBillingPlatform;
        const runtime = yield* start();
        const paid = yield* paidUser(runtime);
        const { exec, check, provider, now } = paid;
        yield* exec(
          "INSERT INTO subscription_cancellations(paid_attempt_id,subscription_id,payment_source_id,cancelled_at_ms,paid_through_ms,source_cancellation_state,next_offer_at_ms) VALUES (?,?,?,?,?,'void-pending',?)",
          attempt,
          subscription,
          source,
          now,
          now + 3600000,
          now
        );
        yield* exec(
          "CREATE TRIGGER unavailable_claim BEFORE UPDATE OF verification_count ON subscription_cancellations BEGIN SELECT RAISE(ABORT,'unavailable'); END"
        );
        const response = yield* check();
        expect(response.status).toBe(204);
        expect(response.headers.get("fidy-alarm-repaired")).toBe("1");

        const bindings = yield* native(() =>
          runtime.getBindings<{
            BILLING_COLLECTION_WORKFLOW: Workflow;
            BILLING_COLLECTION_QUEUE: Queue;
          }>("core")
        );

        const workflowId = "source-cancel-v3-" + user + "-" + attempt;

        const instance = yield* Effect.tryPromise(() =>
          bindings.BILLING_COLLECTION_WORKFLOW.get(workflowId)
        ).pipe(Effect.retry(Schedule.spaced("50 millis")), Effect.timeout("5 seconds"));

        yield* native(() => instance.status()).pipe(
          Effect.repeat({
            until: (state) => state.status === "errored",
            schedule: Schedule.spaced("50 millis"),
          }),
          Effect.timeout("8 seconds")
        );
        expect(
          yield* exec(
            "SELECT verification_count,void_started_at_ms FROM subscription_cancellations"
          )
        ).toEqual([{ verification_count: 0, void_started_at_ms: null }]);
        yield* exec("DROP TRIGGER unavailable_claim");

        const offer = {
          version: 3,
          kind: "source-cancellation",
          paidAttemptId: attempt,
          userId: user,
        };

        yield* native(() =>
          bindings.BILLING_COLLECTION_QUEUE.sendBatch([{ body: offer }, { body: offer }])
        );
        yield* verified(paid);
        yield* native(() => instance.status()).pipe(
          Effect.repeat({
            until: (state) => state.status === "complete",
            schedule: Schedule.spaced("50 millis"),
          }),
          Effect.timeout("3 seconds")
        );

        const [evidence] = yield* exec(
          "SELECT void_started_at_ms,void_verified_at_ms,verification_count,next_offer_at_ms FROM subscription_cancellations"
        );

        expect(evidence?.["void_started_at_ms"]).toEqual(expect.any(Number));
        expect(evidence?.["void_verified_at_ms"]).toEqual(expect.any(Number));
        expect(evidence).toMatchObject({
          verification_count: 1,
          next_offer_at_ms: null,
        });
        expect(
          yield* native(() => provider.exec("SELECT COUNT(*) AS total FROM received_voids"))
        ).toEqual([{ total: 1 }]);
      })
  );
});
