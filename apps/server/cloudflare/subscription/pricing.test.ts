import { it } from "@effect/vitest";
import { Clock, Effect, FileSystem, Schedule, Schema } from "effect";
import { NodeFileSystem } from "@effect/platform-node";
import { expect } from "vitest";
import { Miniflare } from "miniflare";
import { ownerCheckUrl } from "../maintenance/contract";
import type { Price } from "../../src/core/subscription/contract";

const price = {
  id: "22700000-0000-4000-8000-000000000011",
  money: { amount: "11900", currency: "COP" },
  serviceMarket: "CO",
  billingPeriod: "weekly",
  taxTreatment: "not-taxable",
  renewalTerms: {
    automaticRenewal: true,
    renewalReminder: "none",
    cancellation: "future-renewals-only",
    paidAccessEnds: "paid-period-end",
  },
  paymentMethods: ["card", "nequi", "daviplata"],
} as const satisfies typeof Price.Encoded;

const makePublication = Effect.map(Clock.currentTimeMillis, (now) => ({
  publicationId: "22700000-0000-4000-8000-000000000099",
  authority: {
    permission: "pricing.publish",
    operatorId: "operator-1",
    expiresAtMs: now + 60_000,
  },
  price,
}));

const pricingTestCeiling = 256 * 1024;

const encode = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

const platform = Effect.fnUntraced(function* (routeUsers: boolean = false) {
  const fs = yield* FileSystem.FileSystem;
  const directory = yield* fs.makeTempDirectoryScoped({ prefix: "fidy-pricing-" });

  const build = yield* Effect.tryPromise(() =>
    Bun.build({
      entrypoints: [new URL("./pricing.test-fixture.ts", import.meta.url).pathname],
      target: "browser",
      external: ["cloudflare:workers"],
    })
  );

  const output = build.outputs[0];

  if (!build.success || output === undefined) {
    return yield* Effect.die(new Error("Pricing fixture build failed"));
  }

  const contents = yield* Effect.tryPromise(() => output.text());

  const userStoreBinding:
    | Readonly<Record<never, never>>
    | Readonly<{
        USER_STORE: Readonly<{ type: "durable-object"; worker: string; exportName: string }>;
      }> = routeUsers
    ? {
        USER_STORE: {
          type: "durable-object" as const,
          worker: "pricing-test",
          exportName: "PricingFixture",
        },
      }
    : {};

  const create = (): Miniflare =>
    new Miniflare({
      resourcePersistencePath: directory,
      workers: [
        {
          config: {
            type: "worker",
            name: "pricing-test",
            compatibilityDate: "2026-09-08",
            env: {
              SQLITE_STORE_CAPACITY_BYTES: { type: "text", value: String(pricingTestCeiling) },
              CF_VERSION_METADATA: { type: "version-metadata" },
              ...userStoreBinding,
              PRICING: {
                type: "durable-object",
                worker: "pricing-test",
                exportName: "PricingFixture",
              },
            },
            exports: { PricingFixture: { type: "durable-object", storage: "sqlite" } },
            manifest: {
              mainModule: "index.mjs",
              modules: { "index.mjs": { type: "esm", contents } },
            },
          },
        },
      ],
    });

  let runtime = create();
  yield* Effect.addFinalizer(() => Effect.tryPromise(() => runtime.dispose()).pipe(Effect.orDie));

  const request = Effect.fnUntraced(function* (
    path: string,
    body?: unknown,
    name: string = "pricing"
  ) {
    const namespace = yield* Effect.tryPromise(() => runtime.getDurableObjectNamespace("PRICING"));

    const response = yield* Effect.tryPromise(() =>
      namespace.getByName(name).fetch(
        "https://pricing.internal/" + path,
        body === undefined
          ? {}
          : {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: encode(body),
            }
      )
    );

    const text = yield* Effect.tryPromise(() => response.text());

    return {
      status: response.status,
      body:
        text === ""
          ? null
          : yield* Schema.decodeEffect(Schema.fromJsonString(Schema.Unknown))(text),
    };
  });

  const restart = Effect.tryPromise(() => runtime.dispose()).pipe(
    Effect.tap(() =>
      Effect.sync(() => {
        runtime = create();
      })
    )
  );

  const check = Effect.gen(function* () {
    const namespace = yield* Effect.tryPromise(() => runtime.getDurableObjectNamespace("PRICING"));

    const reply = yield* Effect.tryPromise(() =>
      namespace.getByName("pricing").fetch(ownerCheckUrl, { method: "POST" })
    );

    return { status: reply.status, repaired: reply.headers.get("fidy-alarm-repaired") };
  });

  return { request, restart, check, publication: yield* makePublication };
});

it.layer(NodeFileSystem.layer, { excludeTestServices: true })((test) => {
  test.effect(
    "repairs the registered deadline and retains the exact receipt after its User is unavailable",
    () =>
      Effect.gen(function* () {
        const { request, restart, check } = yield* platform(true);
        expect(yield* check).toEqual({ status: 204, repaired: "0" });
        const deadline = (yield* Clock.currentTimeMillis) + 3000;

        const registration = {
          userId: "12700000-0000-4000-8000-000000000001",
          operationId: "22700000-0000-4000-8000-000000000014",
          admission: {
            kind: "renewal",
            previousPaidAttemptId: "22700000-0000-4000-8000-000000000008",
          },
          billingPeriod: "weekly",
          inputsDigest: "a".repeat(64),
          deadlineMs: deadline,
        };

        const priceId = "22700000-0000-4000-8000-000000000001";
        expect((yield* request("register", registration)).body).toMatchObject({
          ...registration,
          price: { id: priceId },
        });
        expect(yield* check).toEqual({ status: 204, repaired: "0" });
        yield* request("fixture/drop-alarm");
        expect((yield* request("fixture/inspect-recovery")).body).toMatchObject({ alarm: null });
        expect(yield* check).toEqual({ status: 204, repaired: "1" });
        expect((yield* request("fixture/inspect-recovery")).body).toMatchObject({
          alarm: deadline,
        });
        expect(yield* check).toEqual({ status: 204, repaired: "0" });
        yield* request("fixture/forget-registration-wake");
        expect(yield* check).toEqual({ status: 204, repaired: "1" });
        expect((yield* request("fixture/inspect-recovery")).body).toMatchObject({
          alarm: deadline,
          rows: [{ next_check_ms: deadline, outcome: null }],
        });

        const probe = yield* request("fixture/last-probe", undefined, registration.userId).pipe(
          Effect.repeat({
            until: (reply) => reply.body !== null,
            schedule: Schedule.spaced("50 millis"),
          }),
          Effect.timeout("10 seconds")
        );

        expect(probe.body).toEqual(registration);
        yield* restart;

        const retained = yield* Schema.decodeUnknownEffect(
          Schema.Struct({
            alarm: Schema.Int,
            rows: Schema.Array(
              Schema.Struct({
                outcome: Schema.Null,
                request: Schema.String,
                price_id: Schema.String,
                next_check_ms: Schema.Int,
              })
            ),
          })
        )((yield* request("fixture/inspect-recovery")).body);

        expect(retained.rows).toHaveLength(1);
        expect(retained.rows[0]).toMatchObject({
          outcome: null,
          price_id: priceId,
          next_check_ms: retained.alarm,
        });
        expect(
          yield* Schema.decodeEffect(Schema.fromJsonString(Schema.Unknown))(
            String(retained.rows[0]?.request)
          )
        ).toEqual(registration);
        expect(retained.alarm).toBeGreaterThan(deadline);
        expect(yield* check).toEqual({ status: 204, repaired: "0" });
        expect(
          (yield* request("ack", { request: registration, outcome: "committed" })).status
        ).toBe(204);
        expect((yield* request("fixture/inspect-recovery")).body).toMatchObject({
          rows: [{ outcome: "committed", next_check_ms: null }],
        });
      }),
    25000
  );
  test.effect(
    "keeps exact accepted Price work available when pricing reaches its growth restriction",
    () =>
      Effect.gen(function* () {
        const { request, publication } = yield* platform();

        const enrollment = {
          userId: "12700000-0000-4000-8000-000000000001",
          operationId: "22700000-0000-4000-8000-000000000018",
          admission: {
            kind: "enrollment",
            enrollmentId: "22700000-0000-4000-8000-000000000016",
            acceptedPriceId: "22700000-0000-4000-8000-000000000001",
          },
          inputsDigest: "a".repeat(64),
          billingPeriod: "weekly",
          deadlineMs: (yield* Clock.currentTimeMillis) + 60000,
        };

        const accepted = yield* request("register", enrollment);
        expect(accepted.status).toBe(200);
        const before = yield* request("offers");
        const filled = yield* request("fixture/restrict-growth", {});
        expect(filled.status).toBe(200);

        const measurement = yield* Schema.decodeUnknownEffect(
          Schema.Struct({
            healthyBytes: Schema.Int,
            pressureBytes: Schema.Int,
            ceilingBytes: Schema.Int,
          })
        )(filled.body);

        expect(measurement.ceilingBytes).toBe(pricingTestCeiling);
        expect(measurement.healthyBytes).toBeLessThan(pricingTestCeiling * 0.7);
        expect(measurement.pressureBytes).toBeGreaterThanOrEqual(pricingTestCeiling * 0.8);
        expect(measurement.pressureBytes).toBeLessThan(pricingTestCeiling);
        process.stdout.write(`PRICING_CAPACITY ${encode(measurement)}\n`);
        expect((yield* request("publish", publication)).status).toBe(503);
        expect(yield* request("offers")).toEqual(before);
        expect(yield* request("register", enrollment)).toEqual(accepted);
        expect(
          (yield* request("register", {
            ...enrollment,
            operationId: "22700000-0000-4000-8000-000000000014",
            admission: {
              ...enrollment.admission,
              enrollmentId: "22700000-0000-4000-8000-000000000015",
            },
          })).status
        ).toBe(503);
      })
  );
  test.effect("publishes immutable weekly terms without changing the other offers", () =>
    Effect.gen(function* () {
      const { request, publication } = yield* platform();
      expect(yield* request("publish", publication)).toEqual({
        status: 200,
        body: { publicationId: publication.publicationId, priceId: price.id },
      });
      const offers = yield* request("offers");
      expect(offers.status).toBe(200);
      expect(offers.body).toEqual([
        price,
        expect.objectContaining({
          billingPeriod: "monthly",
          money: { amount: "28900", currency: "COP" },
        }),
        expect.objectContaining({
          billingPeriod: "yearly",
          money: { amount: "289900", currency: "COP" },
        }),
      ]);
    })
  );
  test.effect(
    "recovers exact registrations for unavailable Users without holding up publication",
    () =>
      Effect.gen(function* () {
        const { request, restart, check, publication } = yield* platform();

        const next = {
          ...publication,
          publicationId: "22700000-0000-4000-8000-000000000098",
          price: {
            ...price,
            id: "22700000-0000-4000-8000-000000000012",
            money: { amount: "12900", currency: "COP" },
          },
        };

        yield* request("publish", publication);

        const first = {
          userId: "12700000-0000-4000-8000-000000000001",
          operationId: "22700000-0000-4000-8000-000000000014",
          admission: {
            kind: "renewal",
            previousPaidAttemptId: "22700000-0000-4000-8000-000000000008",
          },
          billingPeriod: "weekly",
          inputsDigest: "a".repeat(64),
          deadlineMs: (yield* Clock.currentTimeMillis) + 60_000,
        };

        const registered = yield* request("register", first);
        expect(registered).toEqual({ status: 200, body: { ...first, price } });
        expect(yield* check).toEqual({ status: 503, repaired: null });
        expect((yield* request("publish", next)).status).toBe(200);
        yield* restart;
        expect((yield* request("publish", publication)).body).toEqual({
          publicationId: publication.publicationId,
          priceId: price.id,
        });
        expect(yield* request("register", first)).toEqual(registered);
        expect(
          (yield* request("register", { ...first, deadlineMs: first.deadlineMs + 1 })).status
        ).toBe(409);
        expect(
          (yield* request("register", { ...first, inputsDigest: "b".repeat(64) })).status
        ).toBe(409);
        expect(
          (yield* request("register", { ...first, userId: "12700000-0000-4000-8000-000000000002" }))
            .status
        ).toBe(409);
        expect((yield* request("register", { ...first, deadlineMs: 0 })).status).toBe(410);

        const other = {
          ...first,
          userId: "12700000-0000-4000-8000-000000000002",
          operationId: "22700000-0000-4000-8000-000000000015",
        };

        expect(yield* request("register", other)).toEqual({
          status: 200,
          body: { ...other, price: next.price },
        });

        const form = {
          ...other,
          operationId: "22700000-0000-4000-8000-000000000016",
          admission: {
            kind: "enrollment",
            enrollmentId: "22700000-0000-4000-8000-000000000017",
            acceptedPriceId: price.id,
          },
        };

        expect((yield* request("register", form)).status).toBe(409);
        expect(
          (yield* request("register", {
            ...form,
            admission: { ...form.admission, acceptedPriceId: next.price.id },
          })).status
        ).toBe(200);
      })
  );
  test.effect(
    "rolls back a failed publication receipt and recovers a lost response after reconstruction",
    () =>
      Effect.gen(function* () {
        const { request, restart, publication } = yield* platform();
        const original = yield* request("offers");
        expect((yield* request("fixture/fail-before-receipt", publication)).status).toBe(503);
        yield* restart;
        expect(yield* request("offers")).toEqual(original);
        expect((yield* request("fixture/lose-response", publication)).status).toBe(503);
        yield* restart;
        expect((yield* request("publish", publication)).body).toEqual({
          publicationId: publication.publicationId,
          priceId: price.id,
        });
        expect(
          (yield* request("publish", {
            ...publication,
            price: { ...price, money: { amount: "14900", currency: "COP" } },
          })).status
        ).toBe(409);
        expect((yield* request("offers")).body).toEqual(expect.arrayContaining([price]));
        expect(
          (yield* request("publish", {
            ...publication,
            authority: { ...publication.authority, expiresAtMs: 0 },
          })).status
        ).toBe(403);
        expect((yield* request("publish", publication, "another-catalog")).status).toBe(404);
      })
  );
});
