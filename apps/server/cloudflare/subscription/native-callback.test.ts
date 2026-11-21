import { caseDriver } from "../erasure-purge.test-fixture";
import type { Miniflare } from "miniflare";
import { type LocalBillingCollection, settleUserBillingUrl } from "./contract";
import { NodeFileSystem } from "@effect/platform-node";
import { it } from "@effect/vitest";
import { Data, Effect, Schedule } from "effect";
import { expect } from "vitest";
import { alice, bob, seed } from "../financial-user-store.test-fixture";
import { native, nativeBillingPlatform } from "../user-store.test-fixture";
import { browserOrigins, productionTopology } from "../runtime/contract";
import { Hex } from "effect/encoding";

const BillingWire = Data.taggedEnum<typeof LocalBillingCollection.Encoded>();

const attemptId = "22430000-0000-4000-8000-000000000001";

const reference = "fidy-" + attemptId;

const work = BillingWire.CollectUserBillingAttempt({ userId: alice.user, attemptId });

const until = (check: Effect.Effect<boolean>): Effect.Effect<void, "pending"> =>
  check.pipe(
    Effect.flatMap((done) => (done ? Effect.void : Effect.fail("pending" as const))),
    Effect.retry({ times: 180, schedule: Schedule.spaced("50 millis") })
  );

const callbackFixture = Effect.fn(function* () {
  const create = yield* nativeBillingPlatform;
  const runtime = yield* create();
  const owner = yield* seed(runtime, alice);
  yield* owner.exec(
    "INSERT INTO consent_history(id,user_id,record_type,occurred_at_ms) VALUES ('grant',?,'processing_grant',?)",
    alice.user,
    owner.now
  );
  yield* owner.exec("INSERT INTO subscriptions(id,user_id) VALUES ('sub',?)", alice.user);
  yield* owner.exec(
    "INSERT INTO payment_sources(id,subscription_id,billing_email,method,wompi_source_id,wompi_environment) VALUES('src','sub','payer@example.com','card',5101,'sandbox')"
  );
  yield* owner.exec(
    "INSERT INTO billing_attempts(id,subscription_id,payment_source_id,wompi_environment,wompi_reference,amount,currency,billing_period,time_zone,collection_state) VALUES (?,'sub','src','sandbox',?,'29900','COP','monthly','America/Bogota','armed')",
    attemptId,
    reference
  );

  const db = yield* native(() =>
    runtime.unsafeGetDurableObjectStorage("wompi-fixture", "ProviderState", { name: "provider" })
  );

  yield* native(() =>
    db.exec(
      "CREATE TABLE charge_posts(reference TEXT,amount INTEGER,currency TEXT,source INTEGER); CREATE TABLE charge_control(released INTEGER,reference TEXT,amount INTEGER,source INTEGER)"
    )
  );
  yield* native(() => db.exec("INSERT INTO charge_control VALUES(0,?,2990000,5101)", reference));

  return { owner, runtime, db };
});

const observer = (
  owners: Awaited<ReturnType<Miniflare["getDurableObjectNamespace"]>>
): ((body: unknown, id?: string) => Effect.Effect<number>) =>
  Effect.fn(function* (body: unknown, id = alice.user) {
    const response = yield* native(() =>
      owners
        .getByName(id)
        .fetch(settleUserBillingUrl, { method: "POST", body: JSON.stringify(body) })
    );

    return response.status;
  });

type CallbackFixture = Effect.Success<ReturnType<typeof callbackFixture>>;

const expectWompiCustodyPending = Effect.fnUntraced(function* (
  owner: CallbackFixture["owner"],
  runtime: CallbackFixture["runtime"]
) {
  expect(yield* owner.exec("SELECT followup_due_at_ms FROM billing_attempts")).toEqual([
    { followup_due_at_ms: null },
  ]);
  const driver = yield* caseDriver(runtime);
  expect(
    yield* driver
      .step()
      .pipe(Effect.repeat({ until: (phase) => phase === "ExternalPending", times: 12 }))
  ).toBe("ExternalPending");
  expect(
    yield* native(() =>
      driver.storage.exec(
        "SELECT observed_use,status FROM erasure_case_custodians WHERE custodian='Wompi'"
      )
    )
  ).toEqual([{ observed_use: 1, status: "Pending" }]);
});

it.layer(NodeFileSystem.layer, { excludeTestServices: true })((test) => {
  test.effect.each([false, true])(
    "settles an authenticated Wompi callback during the charge POST with erasure requested=%s",
    (erase) =>
      Effect.gen(function* () {
        const { owner, runtime, db } = yield* callbackFixture();

        const queue = yield* native(() =>
          runtime.getQueueProducer("BILLING_COLLECTION_QUEUE", "core")
        );

        yield* native(() => queue.send(work));
        yield* until(
          native(() => db.exec("SELECT count(*) AS n FROM charge_posts")).pipe(
            Effect.map((rows) => rows[0]?.n === 1)
          )
        );
        expect(
          yield* native(() =>
            owner.directory.exec(
              "SELECT user_id,operation_id FROM external_event_routes WHERE kind='wompi' AND lookup=?",
              reference
            )
          )
        ).toEqual([{ user_id: alice.user, operation_id: attemptId }]);

        const erasureRequest = native(() =>
          runtime.dispatchFetch(
            `https://${productionTopology.ingress.hostname}/web/privacy/erasure`,
            {
              method: "POST",
              headers: {
                origin: browserOrigins.production,
                "content-type": "application/json",
                "Fidy-Session-Binding": alice.session,
                cookie: "__Host-fidy_session=" + alice.bearer,
              },
              body: JSON.stringify({ confirm: true }),
            }
          )
        );

        yield* Effect.gen(function* () {
          const accepted = yield* erasureRequest;

          expect(accepted.status).toBe(202);
          const driver = yield* caseDriver(runtime);
          yield* driver.step();
          expect(yield* driver.step()).toBe("Draining");
          expect(yield* owner.exec("SELECT status,collection_state FROM billing_attempts")).toEqual(
            [{ status: "pending", collection_state: "sent" }]
          );
        }).pipe(Effect.when(Effect.succeed(erase)));

        const stamp = 1712345678;
        const id = "provider-callback-id";

        const checksum = Hex.encode(
          new Uint8Array(
            yield* native(() =>
              crypto.subtle.digest(
                "SHA-256",
                new TextEncoder().encode(id + "APPROVED" + stamp + "test_events_callback_fixture")
              )
            )
          )
        );

        const notify = (
          environment: string,
          header: string
        ): Effect.Effect<Awaited<ReturnType<typeof runtime.dispatchFetch>>> =>
          native(() =>
            runtime.dispatchFetch(
              `https://${productionTopology.ingress.hostname}/providers/wompi/billing-events`,
              {
                method: "POST",
                headers: { "content-type": "application/json", "x-event-checksum": header },
                body: JSON.stringify({
                  event: "transaction.updated",
                  environment,
                  signature: { properties: ["transaction.id", "transaction.status"], checksum },
                  timestamp: stamp,
                  data: { transaction: { id, status: "APPROVED" } },
                }),
              }
            )
          );

        expect((yield* notify("prod", checksum)).status).toBe(400);
        expect((yield* notify("test", "0".repeat(64))).status).toBe(400);
        expect((yield* notify("test", checksum)).status).toBe(200);
        yield* until(
          owner
            .exec("SELECT status FROM billing_attempts WHERE id=?", attemptId)
            .pipe(Effect.map((rows) => rows[0]?.status === "succeeded"))
        );
        expect((yield* notify("test", checksum)).status).toBe(200);
        yield* native(() => db.exec("UPDATE charge_control SET released=1"));
        yield* native(() => queue.send(work));
        expect(
          yield* owner.exec("SELECT attempt_id,transition FROM billing_transition_audit")
        ).toEqual([{ attempt_id: attemptId, transition: "succeeded" }]);
        expect(yield* owner.exec("SELECT current_paid_attempt_id FROM subscriptions")).toEqual([
          { current_paid_attempt_id: attemptId },
        ]);

        yield* expectWompiCustodyPending(owner, runtime).pipe(Effect.when(Effect.succeed(erase)));

        expect(yield* native(() => db.exec("SELECT count(*) AS n FROM charge_posts"))).toEqual([
          { n: 1 },
        ]);
      })
  );
  test.effect(
    "rechecks captured payment facts and signed generations at the exact User and recognizes same-second approval",
    () =>
      Effect.gen(function* () {
        const { owner, runtime } = yield* callbackFixture();
        const other = yield* seed(runtime, bob);
        const owners = yield* native(() => runtime.getDurableObjectNamespace("USER_STORE", "core"));

        const work = {
          userId: alice.user,
          attemptId,
          environment: "sandbox",
          transactionId: "provider-callback-id",
          reference,
          status: "DECLINED",
          amountInCents: 2990000,
          currency: "COP",
          sourceId: 5101,
          finalizedAt: owner.now,
          generation: { signedAt: 100, signedStatus: "DECLINED" },
        };

        const observe = observer(owners);
        expect(yield* observe(work)).toBe(204);
        yield* owner.exec(
          "UPDATE billing_attempts SET collection_state='sent',collection_sent_at_ms=? WHERE id=?",
          owner.now,
          attemptId
        );

        yield* Effect.forEach(
          [
            { sourceId: 5300 },
            { currency: "USD" },
            { environment: "production" },
            { reference: "fidy-22430000-0000-4000-8000-000000000009" },
            { amountInCents: 0 },
            { userId: bob.user },
          ],
          Effect.fnUntraced(function* (wrong) {
            expect(yield* observe({ ...work, ...wrong })).toBe(204);
          }),
          { discard: true }
        );

        expect(yield* observe(work, bob.user)).toBe(204);
        expect(
          yield* owner.exec("SELECT count(*) AS n FROM billing_provider_transactions")
        ).toEqual([{ n: 0 }]);
        expect(yield* observe(work)).toBe(202);
        expect(
          yield* observe({
            ...work,
            status: "APPROVED",
            generation: { signedAt: 99, signedStatus: "APPROVED" },
          })
        ).toBe(204);
        expect(yield* owner.exec("SELECT status FROM billing_attempts")).toEqual([
          { status: "pending" },
        ]);

        const approved = {
          ...work,
          status: "APPROVED",
          generation: { signedAt: 100, signedStatus: "APPROVED" },
        };

        yield* owner.exec(
          "CREATE TRIGGER suppress_settlement_audit BEFORE INSERT ON billing_transition_audit BEGIN SELECT RAISE(IGNORE); END"
        );
        expect(yield* observe(approved)).toBe(503);
        expect(yield* owner.exec("SELECT status FROM billing_attempts")).toEqual([
          { status: "pending" },
        ]);
        expect(yield* owner.exec("SELECT current_paid_attempt_id FROM subscriptions")).toEqual([
          { current_paid_attempt_id: null },
        ]);
        yield* owner.exec("DROP TRIGGER suppress_settlement_audit");
        expect(yield* observe(approved)).toBe(204);
        expect(yield* observe(work)).toBe(204);
        expect(yield* observe(approved)).toBe(204);
        expect(yield* owner.exec("SELECT status FROM billing_attempts")).toEqual([
          { status: "succeeded" },
        ]);
        expect(yield* owner.exec("SELECT count(*) AS n FROM billing_transition_audit")).toEqual([
          { n: 1 },
        ]);
        expect(
          yield* other.exec("SELECT count(*) AS n FROM billing_provider_transactions")
        ).toEqual([{ n: 0 }]);
      })
  );
});
