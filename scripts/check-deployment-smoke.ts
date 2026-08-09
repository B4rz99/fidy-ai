#!/usr/bin/env bun

import { BunRuntime } from "@effect/platform-bun";
import { type Cause, Data, Effect, Layer, Schema } from "effect";
import {
  FetchHttpClient,
  HttpBody,
  HttpClient,
  type HttpClientError,
  type HttpClientResponse,
} from "effect/unstable/http";

const Health = Schema.Struct({ status: Schema.Literal("ok"), version: Schema.String });
const OpenApi = Schema.Struct({ openapi: Schema.String });
const DuplicateWebhookResponse = Schema.Struct({
  decoded: Schema.Literal(1),
  consentTurns: Schema.Literal(0),
  enqueued: Schema.Literal(0),
  duplicates: Schema.Literal(1),
});

class SmokeFailed extends Data.TaggedError("SmokeFailed")<{ readonly message: string }> {}

const firstSuccessStatus = 200;
const firstRedirectionStatus = 300;
const unauthorizedStatus = 401;
const notFoundStatus = 404;

const rawOrigin = Bun.argv[2] ?? Bun.env.DEPLOYMENT_URL;

if (rawOrigin === undefined) {
  throw new Error("Pass the deployment origin as the first argument or DEPLOYMENT_URL.");
}

const origin = new URL(rawOrigin);

const getDeploymentResponse = (
  path: string
): Effect.Effect<
  HttpClientResponse.HttpClientResponse,
  HttpClientError.HttpClientError | SmokeFailed | Cause.TimeoutError,
  HttpClient.HttpClient
> =>
  HttpClient.get(new URL(path, origin).toString()).pipe(
    Effect.flatMap((response) =>
      response.status >= firstSuccessStatus && response.status < firstRedirectionStatus
        ? Effect.succeed(response)
        : Effect.fail(new SmokeFailed({ message: `${path} returned HTTP ${response.status}.` }))
    ),
    Effect.timeout("10 seconds")
  );

const assertArtifactUnavailable = (
  path: string
): Effect.Effect<
  void,
  HttpClientError.HttpClientError | SmokeFailed | Cause.TimeoutError,
  HttpClient.HttpClient
> =>
  HttpClient.get(new URL(path, origin).toString()).pipe(
    Effect.flatMap((response) =>
      response.status === notFoundStatus
        ? Effect.void
        : Effect.fail(new SmokeFailed({ message: `${path} returned HTTP ${response.status}.` }))
    ),
    Effect.timeout("10 seconds")
  );

const checkWebhookDuplicate = Effect.gen(function* () {
  const webhookSecret = Bun.env.KAPSO_WEBHOOK_SECRET;
  if (webhookSecret === undefined) return;

  const body = yield* Effect.promise(() =>
    Bun.file(
      new URL("../src/shell/channels/whatsapp/fixtures/kapso-text-v2.json", import.meta.url)
    ).bytes()
  );
  const signature = new Bun.CryptoHasher("sha256", webhookSecret).update(body).digest("hex");
  const response = yield* HttpClient.post(new URL("/webhooks/kapso", origin).toString(), {
    headers: {
      "x-webhook-signature": signature,
      "x-idempotency-key": "production-smoke-delivery",
    },
    body: HttpBody.uint8Array(body, "application/json"),
  }).pipe(Effect.timeout("10 seconds"));
  yield* Schema.decodeUnknownEffect(DuplicateWebhookResponse)(yield* response.json);
});

const smoke = Effect.gen(function* () {
  const healthResponse = yield* getDeploymentResponse("/health");
  yield* Schema.decodeUnknownEffect(Health)(yield* healthResponse.json);

  const openApiResponse = yield* getDeploymentResponse("/openapi.json");
  yield* Schema.decodeUnknownEffect(OpenApi)(yield* openApiResponse.json);

  const apiResponse = yield* HttpClient.get(new URL("/user", origin).toString()).pipe(
    Effect.timeout("10 seconds")
  );
  if (apiResponse.status !== unauthorizedStatus) {
    return yield* new SmokeFailed({
      message: `The unauthenticated canonical API returned HTTP ${apiResponse.status}.`,
    });
  }

  const html = yield* (yield* getDeploymentResponse("/")).text;
  if (!html.includes('<html lang="es-CO">') || !html.includes('<div id="root"></div>')) {
    return yield* new SmokeFailed({ message: "/ did not return the es-CO SPA shell." });
  }

  const webhookResponse = yield* HttpClient.post(
    new URL("/webhooks/kapso", origin).toString()
  ).pipe(Effect.timeout("10 seconds"));
  if (webhookResponse.status !== unauthorizedStatus) {
    return yield* new SmokeFailed({
      message: `The unauthenticated Kapso webhook returned HTTP ${webhookResponse.status}.`,
    });
  }

  yield* checkWebhookDuplicate;

  yield* Effect.forEach(
    [
      "/dist/main.js",
      "/dist/main.js.map",
      "/dist/preload.js",
      "/dist/preload.js.map",
      "/dist/commands/migrate.js",
      "/dist/commands/migrate.js.map",
      "/dist/commands/provision-runtime-role.js",
      "/dist/commands/provision-runtime-role.js.map",
      "/.sentry/artifacts.json",
    ],
    assertArtifactUnavailable,
    { discard: true }
  );

  yield* Effect.sync(() => process.stdout.write("Deployment smoke checks passed.\n"));
});

const SmokeLive = Layer.effectDiscard(smoke).pipe(Layer.provide(FetchHttpClient.layer));

BunRuntime.runMain(Effect.scoped(Layer.build(SmokeLive)));
