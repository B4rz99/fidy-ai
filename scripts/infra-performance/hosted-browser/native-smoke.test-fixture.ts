import assert from "node:assert/strict";
import { resolve, sep } from "node:path";
import { Effect } from "effect";
import { FetchHttpClient } from "effect/http";
import { installedOrigins } from "../../../apps/server/src/shell/browser-transport/contract";
import { transport } from "../canonical-fixture/bridge";
import { closedRuntime } from "../canonical-fixture/closed-runtime.test-fixture";
import { parseNativeSmoke } from "./contracts";
import { nativeAccountingSnapshot } from "./native-accounting";
import { runNativeSmoke } from "./native-smoke";

const input: unknown = await Bun.stdin.json();
assert.ok(
  typeof input === "object" &&
    input !== null &&
    "config" in input &&
    "capture" in input &&
    "captureDigest" in input
);
const config = parseNativeSmoke(input.config);
const origins = installedOrigins.acceptance;
const assets = resolve(process.env.NATIVE_WEB_ASSETS ?? "");
const runtime = await Effect.runPromise(
  closedRuntime(
    { revision: config.native.revision, secret: process.env.SMOKE_PROOF },
    process.env.FIDY_REHEARSAL_STATE,
    "performance-2"
  )
);
const client = Object.assign(
  async (input: Parameters<typeof fetch>[0], init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    if (url.origin === origins.api) return Effect.runPromise(transport(runtime)(request));
    assert.equal(url.origin, origins.browser);
    if (url.pathname === "/deployment-metadata.json") {
      return Response.json({
        gitRevision: config.native.web.revision,
        contractDigest: config.native.web.contractDigest,
      });
    }
    const path = resolve(
      assets,
      url.pathname === "/app/transactions" ? "index.html" : "." + url.pathname
    );
    assert.ok(path.startsWith(assets + sep));
    const file = Bun.file(path);
    return (await file.exists()) ? new Response(file) : new Response(null, { status: 404 });
  },
  { preconnect: fetch.preconnect }
);
const witness = Effect.fn(function* (phase: "before" | "after") {
  return yield* nativeAccountingSnapshot({
    phase,
    capture: input.capture,
    captureDigest: input.captureDigest,
    deadline: config.deadline,
    ...config.native.session,
  }).pipe(
    Effect.provide(FetchHttpClient.layer),
    Effect.provideService(FetchHttpClient.Fetch, client)
  );
});

try {
  const before = await Effect.runPromise(witness("before"));
  const smoke = await runNativeSmoke({ config, http: client });
  const after = await Effect.runPromise(witness("after"));
  process.stdout.write(JSON.stringify({ before, smoke, after }));
} finally {
  await runtime.dispose();
}
