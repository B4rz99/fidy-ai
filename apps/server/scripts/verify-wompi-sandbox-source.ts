#!/usr/bin/env bun

import { BunRuntime, BunServices } from "@effect/platform-bun";
import { Config, Console, DateTime, Effect, Layer, Redacted } from "effect";
import { FetchHttpClient } from "effect/unstable/http";
import { BillingEmail } from "~/core/subscription/enrollment-model";
import { WompiEnrollmentClient } from "~/shell/subscription/wompi-client";

const verifyReusableSource = Effect.gen(function* () {
  const environment = yield* Config.string("WOMPI_ENVIRONMENT");
  if (environment !== "sandbox") return yield* Effect.die("Sandbox verification requires sandbox");
  const billingEmail = yield* Config.schema(BillingEmail, "WOMPI_SANDBOX_BILLING_EMAIL");
  const cardToken = yield* Config.redacted("WOMPI_SANDBOX_CARD_TOKEN");
  const wompi = yield* WompiEnrollmentClient;
  const contracts = yield* wompi.contracts(yield* DateTime.now);
  const result = yield* wompi.createPaymentSource({
    cardToken: Redacted.make(Redacted.value(cardToken)),
    billingEmail,
    contracts,
  });
  if (result._tag !== "Available") return yield* Effect.die("Wompi refused the reusable source");
  const verified = yield* wompi.verifyPaymentSource(result.sourceId);
  if (verified.billingEmail !== billingEmail) {
    return yield* Effect.die("Wompi returned a source for a different billing email");
  }
  yield* Console.log("Wompi Sandbox confirmed an available reusable source.");
});

const VerifyLive = Layer.effectDiscard(verifyReusableSource).pipe(
  Layer.provide(WompiEnrollmentClient.layer),
  Layer.provide(FetchHttpClient.layer),
  Layer.provide(BunServices.layer)
);

BunRuntime.runMain(Effect.scoped(Layer.build(VerifyLive)));
