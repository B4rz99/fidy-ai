#!/usr/bin/env bun

import { BunRuntime } from "@effect/platform-bun";
import { Effect, Layer } from "effect";
import { FetchHttpClient } from "effect/unstable/http";
import { deploymentSmokeCommand } from "~/shell/observability/deployment-smoke-command";

const DeploymentSmokeLive = Layer.effectDiscard(deploymentSmokeCommand).pipe(
  Layer.provide(FetchHttpClient.layer)
);

BunRuntime.runMain(Effect.scoped(Layer.build(DeploymentSmokeLive)));
