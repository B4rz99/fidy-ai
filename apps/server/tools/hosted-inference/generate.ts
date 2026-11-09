#!/usr/bin/env bun

import { Effect, Schema } from "effect";
import { makeHostedToolParameters } from "~/shell/hosted-inference/operations";

const main = Effect.gen(function* () {
  const arguments_ = Bun.argv.slice(2);
  if (arguments_.some((argument) => argument !== "--check")) {
    throw new Error("Expected only --check for hosted tool generation");
  }
  const file = Bun.file(
    new URL(
      "../../src/shell/hosted-inference/internal/tool-parameters.generated.json",
      import.meta.url
    )
  );
  const parameters = yield* Schema.decodeUnknownEffect(Schema.Json)(makeHostedToolParameters());
  const text = `${yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Json, { space: 2 }))(parameters)}\n`;
  if (arguments_.includes("--check")) {
    const present = yield* Effect.tryPromise(() => file.exists());
    if (!present || (yield* Effect.tryPromise(() => file.text())) !== text) {
      throw new Error("Hosted tool parameters are stale. Run bun run contracts:generate.");
    }
  } else {
    yield* Effect.tryPromise(() => Bun.write(file, text));
  }
  process.stdout.write("Hosted tool parameters are fresh.\n");
});

if (import.meta.main) await Effect.runPromise(main);
