#!/usr/bin/env bun

import { BunRuntime } from "@effect/platform-bun";
import { Config, Console, Effect, Layer } from "effect";
import { FetchHttpClient } from "effect/unstable/http";
import {
  renderSentryVerificationReport,
  verifySentryAccount,
} from "~/shell/observability/account-policy";
import {
  inspectSentryAccount,
  unavailableSentryAccountObservation,
} from "~/shell/observability/sentry-account-reader";

const accountConfig = Config.all({
  authToken: Config.redacted("SENTRY_AUTH_TOKEN"),
  organizationSlug: Config.redacted("SENTRY_ORGANIZATION_SLUG"),
  productionProjectSlug: Config.redacted("SENTRY_PRODUCTION_PROJECT_SLUG"),
  nonProductionProjectSlug: Config.redacted("SENTRY_NON_PRODUCTION_PROJECT_SLUG"),
});

const verify = Effect.gen(function* () {
  const config = yield* accountConfig;
  const observation = yield* inspectSentryAccount(config).pipe(
    Effect.catchTag("SentryAccountReadError", () =>
      Effect.succeed(unavailableSentryAccountObservation)
    )
  );
  const report = verifySentryAccount({ observation });
  yield* Console.log(renderSentryVerificationReport(report));
});

const VerifyLive = Layer.effectDiscard(verify).pipe(Layer.provide(FetchHttpClient.layer));

BunRuntime.runMain(Effect.scoped(Layer.build(VerifyLive)));
