#!/usr/bin/env bun

import { BunRuntime, BunServices } from "@effect/platform-bun";
import { Effect, Layer } from "effect";
import { MigratorLive } from "~/shell/db/client";

const MigrationLive = MigratorLive.pipe(Layer.provide(BunServices.layer));

BunRuntime.runMain(Effect.scoped(Layer.build(MigrationLive)));
