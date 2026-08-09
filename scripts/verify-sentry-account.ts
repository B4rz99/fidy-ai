#!/usr/bin/env bun

import { BunRuntime } from "@effect/platform-bun";
import { Config, Console, Effect, Layer, Option } from "effect";
import { FetchHttpClient } from "effect/unstable/http";
import {
  type SentryOperatorEvidence,
  renderSentryVerificationReport,
  verifySentryAccount,
} from "~/shell/observability/account-policy";
import { readSentryOperatorEvidence } from "~/shell/observability/sentry-account-evidence";
import {
  inspectSentryAccount,
  unavailableSentryAccountObservation,
} from "~/shell/observability/sentry-account-reader";

const operatorConfig = Config.all({
  authToken: Config.redacted("SENTRY_AUTH_TOKEN"),
  organizationSlug: Config.redacted("SENTRY_ORGANIZATION_SLUG"),
  productionProjectSlug: Config.redacted("SENTRY_PRODUCTION_PROJECT_SLUG"),
  nonProductionProjectSlug: Config.redacted("SENTRY_NON_PRODUCTION_PROJECT_SLUG"),
});

const evidencePath = Option.fromNullishOr(Bun.argv[2]);

const readEvidence = Option.match(evidencePath, {
  onNone: () => Effect.succeed(Option.none<SentryOperatorEvidence>()),
  onSome: (path) => readSentryOperatorEvidence(Bun.file(path)).pipe(Effect.map(Option.some)),
});

const verify = Effect.gen(function* () {
  const config = yield* operatorConfig;
  const observation = yield* inspectSentryAccount(config).pipe(
    Effect.catchTag("SentryAccountReadError", () =>
      Effect.succeed(unavailableSentryAccountObservation)
    )
  );
  const evidence = yield* readEvidence;
  const report = verifySentryAccount({ observation, evidence });
  yield* Console.log(renderSentryVerificationReport(report));
});

const VerifyLive = Layer.effectDiscard(verify).pipe(Layer.provide(FetchHttpClient.layer));

BunRuntime.runMain(Effect.scoped(Layer.build(VerifyLive)));
