import { it } from "@effect/vitest";
import { type Cause, Effect, FileSystem, Schema } from "effect";
import { NodeFileSystem } from "@effect/platform-node";
import { expect } from "vitest";
import { Miniflare } from "miniflare";
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

const publication = {
  publicationId: "22700000-0000-4000-8000-000000000099",
  authority: {
    permission: "pricing.publish",
    operatorId: "operator-1",
    expiresAtMs: Date.now() + 60_000,
  },
  price,
};
const encode = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const platform = Effect.gen(function* () {
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
  const request = (
    path: string,
    body?: unknown,
    name = "pricing"
  ): Effect.Effect<{ status: number; body: unknown }, Cause.UnknownError> =>
    Effect.tryPromise(async () => {
      const namespace = await runtime.getDurableObjectNamespace("PRICING");
      const response = await namespace.getByName(name).fetch(
        "https://pricing.internal/" + path,
        body === undefined
          ? {}
          : {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: encode(body),
            }
      );
      const text = await response.text();
      return {
        status: response.status,
        body: text === "" ? null : Schema.decodeSync(Schema.fromJsonString(Schema.Unknown))(text),
      };
    });
  const restart = Effect.tryPromise(async () => {
    await runtime.dispose();
    runtime = create();
  });
  return { request, restart };
});

it.layer(NodeFileSystem.layer, { excludeTestServices: true })((test) => {
  test.effect("publishes immutable weekly terms without changing the other offers", () =>
    Effect.gen(function* () {
      const { request } = yield* platform;
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
        const { request, restart } = yield* platform;
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
          deadlineMs: Date.now() + 60_000,
        };
        const registered = yield* request("register", first);
        expect(registered).toEqual({ status: 200, body: { ...first, price } });
        // No User binding exists in this installation. The first registration stays unresolved.
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
        const { request, restart } = yield* platform;
        const original = yield* request("offers");
        expect((yield* request("fixture/fail-before-receipt", {})).status).toBe(204);
        expect((yield* request("publish", publication)).status).toBe(503);
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
