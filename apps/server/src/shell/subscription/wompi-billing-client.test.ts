import { BunServices } from "@effect/platform-bun";
import { expect, it, layer } from "@effect/vitest";
import { type Config, ConfigProvider, Effect, Layer } from "effect";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";
import { BillingEmail, WompiSourceId } from "~/core/subscription/enrollment-model";
import { WompiTransactionId, WompiTransactionReference } from "~/core/subscription/model";
import { WompiBillingClient } from "./wompi-billing-client";

const config = ConfigProvider.layer(
  ConfigProvider.fromUnknown({
    WOMPI_ENVIRONMENT: "sandbox",
    WOMPI_PRIVATE_KEY: "prv_test_examplekey",
    WOMPI_INTEGRITY_SECRET: "test_integrity_examplekey",
  })
);

const recordedCreatedTransaction = await Bun.file(
  new URL("./fixtures/wompi-transaction-created.sandbox.json", import.meta.url)
).text();
const recordedApprovedTransaction = await Bun.file(
  new URL("./fixtures/wompi-transaction-approved.sandbox.json", import.meta.url)
).text();
const recordedDeclinedTransaction = await Bun.file(
  new URL("./fixtures/wompi-transaction-declined.sandbox.json", import.meta.url)
).text();
const successResponse = (method: string): Response =>
  method === "GET"
    ? new Response(recordedApprovedTransaction)
    : new Response(recordedCreatedTransaction, { status: 201 });
const clientLayer = (
  response: (method: string) => Response,
  configLayer: typeof config = config
): Layer.Layer<WompiBillingClient, Config.ConfigError> =>
  WompiBillingClient.layer.pipe(
    Layer.provide(
      Layer.merge(
        Layer.succeed(
          HttpClient.HttpClient,
          HttpClient.make((request) =>
            Effect.succeed(HttpClientResponse.fromWeb(request, response(request.method)))
          )
        ),
        configLayer
      )
    ),
    Layer.provide(BunServices.layer)
  );
const TestLayer = clientLayer(successResponse);
const creationInput = {
  reference: WompiTransactionReference.make("fidy-22900000-0000-4000-8000-000000000001"),
  amountInCents: 2_890_000,
  currency: "COP" as const,
  billingEmail: BillingEmail.make("payer@example.com"),
  sourceId: WompiSourceId.make(3891),
};

layer(TestLayer, { excludeTestServices: true })("Wompi billing adapter", (it) => {
  it.effect("creates and projects a pending source transaction", () =>
    Effect.gen(function* () {
      const wompi = yield* WompiBillingClient;
      const result = yield* wompi.createTransaction(creationInput);
      expect(result).toMatchObject({
        transactionId: WompiTransactionId.make("transaction-123"),
        reference: "fidy-22900000-0000-4000-8000-000000000001",
      });
    })
  );

  it.effect("finds a transaction only by its authoritative provider identity", () =>
    Effect.gen(function* () {
      const wompi = yield* WompiBillingClient;
      expect(
        yield* wompi.findTransaction(WompiTransactionId.make("transaction-123"))
      ).toMatchObject({
        status: "APPROVED",
        sourceId: 3891,
      });
    })
  );
});

layer(
  clientLayer(() => new Response(recordedDeclinedTransaction)),
  {
    excludeTestServices: true,
  }
)("recorded Wompi decline", (it) => {
  it.effect("decodes a declined transaction without manufacturing finalization", () =>
    Effect.gen(function* () {
      const wompi = yield* WompiBillingClient;
      const transaction = yield* wompi.findTransaction(WompiTransactionId.make("transaction-123"));
      expect(transaction).toMatchObject({ status: "DECLINED" });
      expect(transaction.finalizedAt._tag).toBe("None");
    })
  );
});

layer(
  clientLayer(() => new Response("provider response secret", { status: 422 })),
  {
    excludeTestServices: true,
  }
)("Wompi billing refusal", (it) => {
  it.effect("keeps Wompi integrity credentials and response bodies out of failures", () =>
    Effect.gen(function* () {
      const wompi = yield* WompiBillingClient;
      const failure = yield* Effect.flip(wompi.createTransaction(creationInput));
      expect(failure).toMatchObject({
        _tag: "WompiTransactionCreationFailed",
        certainty: "rejected",
      });
      expect(String(failure)).not.toContain("test_integrity_examplekey");
      expect(String(failure)).not.toContain("provider response secret");
    })
  );
});

layer(
  clientLayer((method) =>
    method === "GET" ? Response.json({ data: {} }) : new Response("not-json", { status: 201 })
  ),
  { excludeTestServices: true }
)("malformed Wompi responses", (it) => {
  it.effect("rejects malformed creation and lookup bodies", () =>
    Effect.gen(function* () {
      const wompi = yield* WompiBillingClient;
      const creation = yield* Effect.flip(wompi.createTransaction(creationInput));
      expect(creation.certainty).toBe("ambiguous");
      yield* Effect.flip(wompi.findTransaction(WompiTransactionId.make("transaction-123")));
    })
  );
});

layer(
  clientLayer(() => new Response(undefined, { status: 503 })),
  {
    excludeTestServices: true,
  }
)("unavailable Wompi responses", (it) => {
  it.effect("classifies server refusal as ambiguous and rejects failed lookup", () =>
    Effect.gen(function* () {
      const wompi = yield* WompiBillingClient;
      const creation = yield* Effect.flip(wompi.createTransaction(creationInput));
      expect(creation.certainty).toBe("ambiguous");
      yield* Effect.flip(wompi.findTransaction(WompiTransactionId.make("transaction-123")));
    })
  );
});

for (const status of [404, 408, 429] as const) {
  layer(
    clientLayer(() => new Response("provider refusal", { status })),
    {
      excludeTestServices: true,
    }
  )(`retryable Wompi refusal ${status}`, (it) => {
    it.effect(`treats a ${status} creation response as ambiguous`, () =>
      Effect.gen(function* () {
        const wompi = yield* WompiBillingClient;
        const creation = yield* Effect.flip(wompi.createTransaction(creationInput));
        expect(creation.certainty).toBe("ambiguous");
      })
    );
  });
}

layer(
  clientLayer(() => Response.error()),
  { excludeTestServices: true }
)("Wompi transport failure response", (it) => {
  it.effect("treats a response without an HTTP status as ambiguous", () =>
    Effect.gen(function* () {
      const wompi = yield* WompiBillingClient;
      const creation = yield* Effect.flip(wompi.createTransaction(creationInput));
      expect(creation.certainty).toBe("ambiguous");
      yield* Effect.flip(wompi.findTransaction(WompiTransactionId.make("transaction-123")));
    })
  );
});

const productionConfig = ConfigProvider.layer(
  ConfigProvider.fromUnknown({
    WOMPI_ENVIRONMENT: "production",
    WOMPI_PRIVATE_KEY: "prv_prod_examplekey",
    WOMPI_INTEGRITY_SECRET: "prod_integrity_examplekey",
  })
);
layer(clientLayer(successResponse, productionConfig), { excludeTestServices: true })(
  "production Wompi configuration",
  (it) => {
    it.effect("selects the production provider environment", () =>
      Effect.gen(function* () {
        const wompi = yield* WompiBillingClient;
        expect(wompi.environment).toBe("production");
      })
    );
  }
);

const invalidConfiguration = (privateKey: string, integritySecret: string): typeof config =>
  ConfigProvider.layer(
    ConfigProvider.fromUnknown({
      WOMPI_ENVIRONMENT: "sandbox",
      WOMPI_PRIVATE_KEY: privateKey,
      WOMPI_INTEGRITY_SECRET: integritySecret,
    })
  );

for (const [name, privateKey, integritySecret] of [
  ["private-key shape", "invalid", "test_integrity_examplekey"],
  ["integrity-secret shape", "prv_test_examplekey", "invalid"],
  ["private-key prefix", "prv_prod_examplekey", "test_integrity_examplekey"],
  ["integrity-secret prefix", "prv_test_examplekey", "prod_integrity_examplekey"],
] as const) {
  it.effect(`rejects invalid Wompi ${name}`, () =>
    Effect.gen(function* () {
      const built = Effect.scoped(
        Layer.build(clientLayer(successResponse, invalidConfiguration(privateKey, integritySecret)))
      );
      expect((yield* Effect.exit(built))._tag).toBe("Failure");
    })
  );
}
