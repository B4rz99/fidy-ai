import assert from "node:assert/strict";
import { BunServices } from "@effect/platform-bun";
import { Config, Effect, Path } from "effect";
import { native } from "../../../apps/server/cloudflare/user-store.test-fixture";
import { FetchHttpClient } from "effect/http";
import { installedOrigins } from "../../../apps/server/src/shell/browser-transport/contract";
import { transport } from "../canonical-fixture/bridge";
import { closedRuntime } from "../canonical-fixture/closed-runtime.test-fixture";
import { parseNativeSmoke } from "./contracts";
import { nativeAccountingSnapshot } from "./native-accounting";
import { runNativeSmoke } from "./native-smoke";

const readLocalAsset = Effect.fnUntraced(function* (
  path: Path.Path,
  assets: string,
  pathname: string
) {
  const source = path.resolve(
    assets,
    pathname === "/app/transactions" ? "index.html" : "." + pathname
  );
  assert.ok(source.startsWith(assets + path.sep));
  const file = Bun.file(source);
  return (yield* native(() => file.exists()))
    ? new Response(file)
    : new Response(null, { status: 404 });
});

const run = Effect.gen(function* () {
  const input: unknown = yield* native(() => Bun.stdin.json());
  assert.ok(
    typeof input === "object" &&
      input !== null &&
      "config" in input &&
      "capture" in input &&
      "captureDigest" in input
  );
  const config = parseNativeSmoke(input.config);
  const origins = installedOrigins.acceptance;
  const path = yield* Path.Path;
  const assets = path.resolve(yield* Config.String("NATIVE_WEB_ASSETS"));
  const secret = yield* Config.String("SMOKE_PROOF");
  const directory = yield* Config.String("FIDY_REHEARSAL_STATE");
  const network = yield* FetchHttpClient.Fetch;
  yield* Effect.acquireUseRelease(
    closedRuntime({ revision: config.native.revision, secret }, directory, "performance-2"),
    (runtime) => {
      const read = Effect.fnUntraced(function* (request: Request) {
        const url = new URL(request.url);
        if (url.origin === origins.api) return yield* transport(runtime)(request);
        assert.equal(url.origin, origins.browser);
        if (url.pathname === "/deployment-metadata.json") {
          return Response.json({
            gitRevision: config.native.web.revision,
            contractDigest: config.native.web.contractDigest,
          });
        }
        return yield* readLocalAsset(path, assets, url.pathname);
      });
      const client: typeof network = Object.assign(
        (input: Parameters<typeof network>[0], init?: Parameters<typeof network>[1]) =>
          Effect.runPromise(read(new Request(input, init))),
        { preconnect: network.preconnect }
      );
      const witness = Effect.fnUntraced(function* (phase: "before" | "after") {
        return yield* nativeAccountingSnapshot({
          phase,
          capture: input.capture,
          captureDigest: input.captureDigest,
          deadline: config.deadline,
          ...config.native.session,
        }).pipe(Effect.provide(FetchHttpClient.layer));
      });
      return Effect.gen(function* () {
        const before = yield* witness("before");
        const smoke = yield* runNativeSmoke(config);
        const after = yield* witness("after");
        process.stdout.write(JSON.stringify({ before, smoke, after }));
      }).pipe(Effect.provideService(FetchHttpClient.Fetch, client));
    },
    (runtime) => native(() => runtime.dispose())
  );
});

await Effect.runPromise(run.pipe(Effect.provide(BunServices.layer)));
