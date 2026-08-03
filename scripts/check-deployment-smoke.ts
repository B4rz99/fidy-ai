#!/usr/bin/env bun

import { BunRuntime } from "@effect/platform-bun";
import { Data, Effect, Layer, Schema } from "effect";
import { FetchHttpClient, HttpClient } from "effect/unstable/http";

const Health = Schema.Struct({ status: Schema.Literal("ok"), version: Schema.String });
const OpenApi = Schema.Struct({ openapi: Schema.String });

class SmokeFailed extends Data.TaggedError("SmokeFailed")<{ readonly message: string }> {}

const rawOrigin = Bun.argv[2] ?? Bun.env.DEPLOYMENT_URL;

if (rawOrigin === undefined) {
  throw new Error("Pass the deployment origin as the first argument or DEPLOYMENT_URL.");
}

const origin = new URL(rawOrigin);

const getDeploymentResponse = (path: string) =>
  HttpClient.get(new URL(path, origin).toString()).pipe(
    Effect.flatMap((response) =>
      response.status >= 200 && response.status < 300
        ? Effect.succeed(response)
        : Effect.fail(new SmokeFailed({ message: `${path} returned HTTP ${response.status}.` }))
    ),
    Effect.timeout("10 seconds")
  );

const smoke = Effect.gen(function* () {
  const healthResponse = yield* getDeploymentResponse("/health");
  yield* Schema.decodeUnknownEffect(Health)(yield* healthResponse.json);

  const openApiResponse = yield* getDeploymentResponse("/openapi.json");
  yield* Schema.decodeUnknownEffect(OpenApi)(yield* openApiResponse.json);

  const html = yield* (yield* getDeploymentResponse("/")).text;
  if (!html.includes('<html lang="es-CO">') || !html.includes('<div id="root"></div>')) {
    return yield* new SmokeFailed({ message: "/ did not return the es-CO SPA shell." });
  }

  yield* Effect.sync(() => process.stdout.write("Deployment smoke checks passed.\n"));
});

const SmokeLive = Layer.effectDiscard(smoke).pipe(Layer.provide(FetchHttpClient.layer));

BunRuntime.runMain(Effect.scoped(Layer.build(SmokeLive)));
