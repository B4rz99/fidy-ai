#!/usr/bin/env bun

import { BunRuntime } from "@effect/platform-bun";
import { Console, Effect, Layer } from "effect";
import { FetchHttpClient } from "effect/unstable/http";
import { verifySentryAccountConfiguration } from "~/shell/observability/runtime";
import { OutboundHttp } from "~/shell/outbound-http/operations";

const VerifyLive = Layer.effectDiscard(
  Effect.flatMap(verifySentryAccountConfiguration, Console.log)
).pipe(Layer.provide(OutboundHttp.sentryLayer), Layer.provide(FetchHttpClient.layer));

BunRuntime.runMain(Effect.scoped(Layer.build(VerifyLive)));
