import { BunServices } from "@effect/platform-bun";
import { expect, layer } from "@effect/vitest";
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
  response: (method: string) => Response
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
        config
      )
    ),
    Layer.provide(BunServices.layer)
  );
const TestLayer = clientLayer(successResponse);

layer(TestLayer, { excludeTestServices: true })("Wompi billing adapter", (it) => {
  it.effect("creates and projects a pending source transaction", () =>
    Effect.gen(function* () {
      const wompi = yield* WompiBillingClient;
      const result = yield* wompi.createTransaction({
        reference: WompiTransactionReference.make("fidy-22900000-0000-4000-8000-000000000001"),
        amountInCents: 2_890_000,
        currency: "COP",
        billingEmail: BillingEmail.make("payer@example.com"),
        sourceId: WompiSourceId.make(3891),
      });
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
      const failure = yield* Effect.flip(
        wompi.createTransaction({
          reference: WompiTransactionReference.make("fidy-22900000-0000-4000-8000-000000000001"),
          amountInCents: 2_890_000,
          currency: "COP",
          billingEmail: BillingEmail.make("payer@example.com"),
          sourceId: WompiSourceId.make(3891),
        })
      );
      expect(failure).toMatchObject({
        _tag: "WompiTransactionCreationFailed",
        certainty: "rejected",
      });
      expect(String(failure)).not.toContain("test_integrity_examplekey");
      expect(String(failure)).not.toContain("provider response secret");
    })
  );
});
