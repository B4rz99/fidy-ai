import { LiveWorkerProvider, Worker } from "alchemy/Cloudflare/Workers";
import { CloudflareEnvironment } from "alchemy/Cloudflare";
import { Stack } from "alchemy/Stack";
import { Provider } from "alchemy/Provider";
import { PlatformServices } from "alchemy/Util/PlatformServices";
import { Credentials, apiTokenCredentials } from "@distilled.cloud/cloudflare/Credentials";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import { Stage } from "alchemy/Stage";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import { expect } from "vitest";
import { it } from "@effect/vitest";
import { workerDriftFields } from "./worker-drift";

const versionId = "163ee99f-f0aa-4101-910e-aae30b4c5aca";
const credential = apiTokenCredentials({ apiToken: "test-only" });
const tags = ["alchemy:stack:FidyCloudflare", "alchemy:stage:production", "alchemy:id:Core"];
const client = HttpClient.make((request) => {
  if (request.method !== "GET") return Effect.die("Worker receipt inspection must not write");
  const path = new URL(request.url).pathname;
  if (path.endsWith("/versions/deleted-version")) {
    return Effect.succeed(
      HttpClientResponse.fromWeb(
        request,
        Response.json(
          {
            success: false,
            errors: [{ code: 100146, message: "Version not found" }],
            messages: [],
          },
          { status: 404 }
        )
      )
    );
  }
  let result: unknown;
  if (path.endsWith("/subdomain")) {
    result = { enabled: false, previews_enabled: false };
  } else if (path.endsWith("/settings")) {
    result = { bindings: [], tags, logpush: false };
  } else if (path.endsWith(`/versions/${versionId}`)) {
    result = { id: versionId, number: 1, metadata: {}, resources: { bindings: [] } };
  } else {
    return Effect.die("Unexpected Worker receipt read");
  }
  return Effect.succeed(
    HttpClientResponse.fromWeb(
      request,
      Response.json({ success: true, errors: [], messages: [], result })
    )
  );
});
const services = Layer.mergeAll(
  PlatformServices,
  Layer.effect(Scope.Scope, Effect.scope),
  Layer.succeed(Stage, "production"),
  Layer.succeed(HttpClient.HttpClient, client),
  Layer.succeed(Credentials, Effect.succeed(credential)),
  Layer.succeed(
    CloudflareEnvironment,
    Effect.succeed({
      type: "apiToken",
      apiToken: credential.apiToken,
      accountId: "test-account",
      source: { type: "env" },
    })
  ),
  Layer.succeed(Stack, {
    name: "FidyCloudflare",
    stage: "production",
    resources: {},
    bindings: {},
    actions: {},
  })
);
const output: Worker["Attributes"] = {
  accountId: "test-account",
  workerId: "immutable-worker-id",
  workerName: "fidy-core",
  namespace: undefined,
  logpush: false,
  url: undefined,
  urls: [],
  domain: undefined,
  tags,
  durableObjectNamespaces: {},
  routes: [],
  crons: [],
  tailConsumers: undefined,
  streamingTailConsumers: undefined,
  hash: undefined,
  affinityZoneIds: undefined,
  versionId,
};

it.layer(Layer.provideMerge(LiveWorkerProvider(), services))((it) => {
  it.effect(
    "keeps the verified upload receipt when reading a gradual-rollout Worker without inventing drift",
    () =>
      Effect.gen(function* () {
        const provider = yield* Provider<Worker>(Worker.Type);
        if (provider.read === undefined) return yield* Effect.die("Worker read unavailable");
        const observed = yield* provider
          .read({
            id: "Core",
            fqn: "FidyCloudflare.production.Core",
            instanceId: "test-instance",
            output,
            olds: { name: "fidy-core", version: { traffic: 0 } },
          })
          .pipe(Effect.orDie);
        expect(workerDriftFields({ expected: output, actual: observed })).toEqual([]);
      })
  );
  it.effect("still reports drift when the saved upload no longer exists", () =>
    Effect.gen(function* () {
      const provider = yield* Provider<Worker>(Worker.Type);
      if (provider.read === undefined) return yield* Effect.die("Worker read unavailable");
      const expected = { ...output, versionId: "deleted-version" };
      const observed = yield* provider
        .read({
          id: "Core",
          fqn: "FidyCloudflare.production.Core",
          instanceId: "test-instance",
          output: expected,
          olds: { name: "fidy-core", version: { traffic: 0 } },
        })
        .pipe(Effect.orDie);
      expect(workerDriftFields({ expected, actual: observed })).toEqual(["versionId"]);
    })
  );
  it.effect("still reports live configuration changes despite a valid upload receipt", () =>
    Effect.gen(function* () {
      const provider = yield* Provider<Worker>(Worker.Type);
      if (provider.read === undefined) return yield* Effect.die("Worker read unavailable");
      const expected = { ...output, logpush: true };
      const observed = yield* provider
        .read({
          id: "Core",
          fqn: "FidyCloudflare.production.Core",
          instanceId: "test-instance",
          output: expected,
          olds: { name: "fidy-core", version: { traffic: 0 } },
        })
        .pipe(Effect.orDie);
      expect(workerDriftFields({ expected, actual: observed })).toEqual(["logpush"]);
    })
  );
});
