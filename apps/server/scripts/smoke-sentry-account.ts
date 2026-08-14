#!/usr/bin/env bun

import { BunRuntime } from "@effect/platform-bun";
import { Console, Effect, Layer } from "effect";
import {
  SentryAccountSmokeLive,
  recordSentryAccountSmoke,
} from "~/shell/observability/sentry-account-smoke";
import { Telemetry } from "~/shell/observability/telemetry";

const smoke = Effect.gen(function* () {
  yield* recordSentryAccountSmoke(yield* Telemetry);
  yield* Console.log(
    "Sentry smoke defect sent. Verify release, source-map, region endpoint, quota, alert, and bounded temporary-key 429 evidence in the live account."
  );
});

const SmokeLive = Layer.effectDiscard(smoke).pipe(Layer.provide(SentryAccountSmokeLive));

BunRuntime.runMain(Layer.launch(SmokeLive));
