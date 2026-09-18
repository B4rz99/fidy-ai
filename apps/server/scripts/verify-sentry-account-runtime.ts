#!/usr/bin/env bun

import { BunRuntime } from "@effect/platform-bun";
import { Console, Effect, Layer } from "effect";
import { verifySentryAccountConfiguration } from "~/shell/observability/runtime";
import { SentryOutboundHttpFetchLive } from "~/shell/outbound-http/runtime";

const VerifyLive = Layer.effectDiscard(
  Effect.flatMap(verifySentryAccountConfiguration, Console.log)
).pipe(Layer.provide(SentryOutboundHttpFetchLive));

BunRuntime.runMain(Effect.scoped(Layer.build(VerifyLive)));
