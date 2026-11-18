import type { Response as MiniflareResponse } from "miniflare";
import { NodeFileSystem } from "@effect/platform-node";
import { it } from "@effect/vitest";
import { Effect, Fiber, Schedule, Schema } from "effect";
import { expect } from "vitest";
import { admitPurge, caseDriver } from "../erasure-purge.test-fixture";
import { alice, seed } from "../financial-user-store.test-fixture";
import { browserOrigins, productionTopology } from "../runtime/contract";
import { native, nativeBillingPlatform } from "../user-store.test-fixture";

it.layer(NodeFileSystem.layer, { excludeTestServices: true })((test) => {
  test.effect.each([false, true])(
    "holds a Wompi source creation until its exact reply, erasure before cancellation=%s",
    (eraseFirst) =>
      Effect.gen(function* () {
        const runtime = yield* (yield* nativeBillingPlatform)();
        const owner = yield* seed(runtime, alice);
        yield* owner.exec(
          "INSERT INTO consent_history(id,user_id,record_type,occurred_at_ms) VALUES('grant',?,'processing_grant',?)",
          alice.user,
          owner.now
        );
        const provider = yield* native(() =>
          runtime.getD1Database("PROVIDER_STATE", "wompi-fixture")
        );
        yield* native(() =>
          provider.exec(
            "CREATE TABLE held_source(issued INTEGER,released INTEGER); INSERT INTO held_source VALUES(0,0)"
          )
        );
        const send = (path: string, body: unknown): Effect.Effect<MiniflareResponse> =>
          native(() =>
            runtime.dispatchFetch(
              "https://" +
                productionTopology.ingress.hostname +
                "/web/subscription/payment-enrollments/" +
                path,
              {
                method: "POST",
                headers: {
                  origin: browserOrigins.production,
                  "content-type": "application/json",
                  "Fidy-Session-Binding": alice.session,
                  cookie: "__Host-fidy_session=" + alice.bearer,
                },
                body: JSON.stringify(body),
              }
            )
          );
        const prepared = yield* send("prepare", {
          method: "card",
          priceId: "22700000-0000-4000-8000-000000000002",
        });
        const { enrollmentId } = yield* Schema.decodeUnknownEffect(
          Schema.Struct({ enrollmentId: Schema.String })
        )(yield* native(() => prepared.json()));
        const submitted = yield* send("submit", {
          method: "card",
          paymentSourceMode: "create",
          billingEmail: "payer@example.com",
          cardToken: "tok_test_held_source",
          enrollmentId,
          paymentRequestId: "22510000-0000-4000-8000-000000000001",
          decisions: {
            acceptedEndUserPolicy: true,
            acceptedPersonalDataAuthorization: true,
            authorizedRecurringCharges: true,
          },
        }).pipe(Effect.forkChild({ startImmediately: true }));
        const issued = yield* native(() =>
          provider.prepare("SELECT issued FROM held_source").first<number>("issued")
        ).pipe(
          Effect.repeat({
            until: (count) => count === 1,
            times: 100,
            schedule: Schedule.spaced("30 millis"),
          })
        );
        expect(issued).toBe(1);
        if (eraseFirst) expect((yield* admitPurge(runtime)).status).toBe(202);
        const [registration] = yield* owner.exec(
          "SELECT request FROM billing_admissions WHERE subject_id=?",
          enrollmentId
        );
        const body = yield* Schema.decodeUnknownEffect(Schema.String)(registration?.request);
        const users = yield* native(() => runtime.getDurableObjectNamespace("USER_STORE", "core"));
        const reply = yield* native(() =>
          users
            .getByName(alice.user)
            .fetch("https://user.invalid/billing/registration-cancel", { method: "POST", body })
        );
        expect(yield* native(() => reply.json())).toMatchObject({ outcome: "cancelled" });
        if (!eraseFirst) expect((yield* admitPurge(runtime)).status).toBe(202);
        const driver = yield* caseDriver(runtime);
        expect(yield* driver.step().pipe(Effect.repeat({ times: 5 }))).toBe("Draining");
        yield* native(() => provider.prepare("UPDATE held_source SET released=1").run());
        yield* Fiber.join(submitted);
        expect(
          yield* driver
            .step()
            .pipe(Effect.repeat({ until: (state) => state === "ExternalPending", times: 12 }))
        ).toBe("ExternalPending");
        expect(
          yield* native(() =>
            driver.storage.exec(
              "SELECT observed_use,status FROM erasure_case_custodians WHERE custodian='Wompi'"
            )
          )
        ).toEqual([{ observed_use: 1, status: "Pending" }]);
        expect(
          yield* native(() =>
            provider.prepare("SELECT issued FROM held_source").first<number>("issued")
          )
        ).toBe(1);
      }),
    30000
  );
});
