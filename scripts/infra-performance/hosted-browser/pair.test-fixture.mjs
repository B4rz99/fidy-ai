// Reopen the actual enrolled User. Only the D1 socket resolves to a network transport.
import assert from "node:assert/strict";
import { join, resolve, sep } from "node:path";
import { Effect } from "effect";
import { parseConfig } from "./contracts";
import { comparePair } from "./protected-pair.mjs";
import { closedRuntime } from "../canonical-fixture/closed-runtime.test-fixture";
import { transport } from "../canonical-fixture/bridge";
import { installedOrigins } from "../../../apps/server/src/shell/browser-transport/contract";

const config = parseConfig(await Bun.stdin.json());
const native = installedOrigins.acceptance;
const maximumPort = 65535;
const port = Number(process.env.LOCAL_D1_PORT);
assert.ok(Number.isInteger(port) && port > 0 && port <= maximumPort);
process.env.FIDY_BROWSER_METER = "true";
const runtime = await Effect.runPromise(
  closedRuntime(
    { revision: config.native.revision, secret: process.env.SMOKE_PROOF },
    process.env.FIDY_REHEARSAL_STATE
  )
);
const root = resolve(process.env.NATIVE_WEB_ASSETS);
/** @param {URL} url Requested URL. */
const readWebAsset = async (url) => {
  const path = resolve(
    root,
    url.pathname === "/app/transactions" ? "index.html" : "." + url.pathname
  );
  assert.ok(path.startsWith(root + sep));
  const file = Bun.file(path);
  return (await file.exists()) ? new Response(file) : new Response(null, { status: 404 });
};
/** @type {import("./contracts").PairHttp} */
const http = async (input, init = {}) => {
  const incoming = new Request(input, init);
  const url = new URL(incoming.url);
  if (url.origin === config.d1.url) {
    return fetch(new Request("http://127.0.0.1:" + port + url.pathname + url.search, incoming), {
      decompress: init.decompress,
      redirect: "error",
    });
  }
  if (
    (url.origin === native.api || url.origin === native.browser) &&
    url.pathname === "/cdn-cgi/trace"
  ) {
    return new Response("loc=ZZ\ncolo=LAB\n");
  }
  if (url.origin === native.api) return Effect.runPromise(transport(runtime)(incoming));
  assert.equal(url.origin, native.browser);
  if (url.pathname === "/deployment-metadata.json") {
    return Response.json({
      gitRevision: config.native.web.revision,
      contractDigest: config.native.web.contractDigest,
    });
  }
  return readWebAsset(url);
};
const counters = async () => {
  /** @param {string} role Workerd binding role. @param {string} path Request path. @returns {Promise<unknown>} Observed result. */
  const get = async (role, path) => {
    const reply = await (await runtime.getWorker(role)).fetch("https://offline.invalid/" + path);
    return reply.json();
  };
  return {
    sql: await get("core", "native-row-counts"),
    r2: Object.fromEntries(
      await Promise.all(
        ["ingress", "core", "closed-provider"].map(async (role) => [
          role,
          await get(role, "r2-counts"),
        ])
      )
    ),
  };
};
const before = await counters();
try {
  const result = await comparePair(config, http, "credential-free workerd (synthetic trace)");
  if (!result.verified) process.exitCode = 1;
} finally {
  await Bun.write(
    join(process.env.FIDY_DIAGNOSTIC_DIR, "ordinary-native-accounting.json"),
    JSON.stringify({ before, after: await counters() })
  );
  await runtime.dispose();
}
