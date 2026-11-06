#!/usr/bin/env bun

import { Effect, Schema } from "effect";
import { operationCatalog } from "~/shell/api";

const main = Effect.gen(function* () {
  const arguments_ = Bun.argv.slice(2);
  if (arguments_.some((argument) => argument !== "--check")) {
    throw new Error("Expected only --check for telemetry metadata generation");
  }
  const file = Bun.file(
    new URL("../../src/shell/observability/canonical-metadata.generated.json", import.meta.url)
  );
  const parameters = yield* Schema.decodeEffect(Schema.Json)(
    operationCatalog.operations.map(({ id, method, route }) => ({ id, method, route }))
  );
  const text = `${yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Json, { space: 2 }))(parameters)}\n`;
  if (arguments_.includes("--check")) {
    const present = yield* Effect.tryPromise(() => file.exists());
    if (!present || (yield* Effect.tryPromise(() => file.text())) !== text) {
      throw new Error("Canonical telemetry metadata are stale. Run bun run contracts:generate.");
    }
  } else {
    yield* Effect.tryPromise(() => Bun.write(file, text));
  }
  process.stdout.write("Canonical telemetry metadata are fresh.\n");
});

if (import.meta.main) await Effect.runPromise(main);
