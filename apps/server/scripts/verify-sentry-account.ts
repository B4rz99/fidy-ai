#!/usr/bin/env bun

import { BunRuntime } from "@effect/platform-bun";
import { Console, Effect, Layer } from "effect";
import { FetchHttpClient } from "effect/unstable/http";
import {
  renderSentryVerificationReport,
  verifySentryAccount,
} from "~/shell/observability/account-policy";
import {
  inspectSentryAccount,
  sentryAccountConfig,
  unavailableSentryAccountObservation,
} from "~/shell/observability/sentry-account-reader";

const verify = Effect.gen(function* () {
  const config = yield* sentryAccountConfig;
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
