// Runner-only test of the actual HTTPS boundary, including browser-generated CORS preflight.
import assert from "node:assert/strict";
import { chromium } from "@playwright/test";
import { Effect } from "effect";
import { installedOrigins } from "../../../apps/server/src/shell/browser-transport/contract.ts";
import { acceptanceRequestAdmitted } from "../../../apps/server/cloudflare/release-isolation/operations.ts";
import { targetId } from "../reference/fresh-transactions.mjs";
import { protectedBrowserProxy } from "./proxy.mjs";

const origins = installedOrigins.acceptance;
const environment = {
  BROWSER_ORIGIN: origins.browser,
  NATIVE_STORAGE_ADMISSION: "closed",
  RECOVERY_ISOLATION: "isolated",
  RELEASE_GIT_SHA: "6".repeat(40),
  SMOKE_PROOF: crypto.randomUUID(),
};
const certificate = Bun.file(process.env.BROWSER_TLS_CERT);
const key = Bun.file(process.env.BROWSER_TLS_KEY);
const tls = { cert: certificate, key };
const web = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  tls,
  fetch: () =>
    new Response("<p>Transaction harness</p>", { headers: { "content-type": "text/html" } }),
});
const observed = [];
const proxy = protectedBrowserProxy({
  origins,
  environment,
  tls,
  forward: async (request) => {
    assert.equal(new URL(request.url).origin, origins.api);
    const verified = await Effect.runPromise(
      acceptanceRequestAdmitted({ environment, boundary: "ingress", request, now: Date.now() })
    );
    const headers = {
      "access-control-allow-origin": origins.browser,
      "access-control-allow-credentials": "true",
      "access-control-allow-headers": "fidy-session-binding, content-type",
      "access-control-allow-methods": "GET, PUT, OPTIONS",
    };
    observed.push({ method: request.method, verified, cookie: request.headers.get("cookie") });
    return new Response(null, { status: verified ? 204 : 503, headers });
  },
});
let browser;
try {
  const apiHost = new URL(origins.api).hostname,
    webHost = new URL(origins.browser).hostname;
  browser = await chromium.launch({
    executablePath: process.env.ASSESSMENT_CHROMIUM,
    args: [
      "--no-proxy-server",
      "--ignore-certificate-errors-spki-list=" + process.env.BROWSER_TLS_PIN,
      "--host-resolver-rules=MAP " +
        apiHost +
        ":443 127.0.0.1:" +
        proxy.port +
        ", MAP " +
        webHost +
        ":443 127.0.0.1:" +
        web.port,
    ],
  });
  const context = await browser.newContext();
  await context.addCookies([
    {
      name: "__Host-fidy_session",
      value: "synthetic",
      url: origins.api,
      httpOnly: true,
      secure: true,
      sameSite: "Lax",
    },
  ]);
  const page = await context.newPage();
  await page.goto(origins.browser);
  const result = await page.evaluate(
    async (api) =>
      (
        await fetch(api + "/transactions?limit=25", {
          headers: { "fidy-session-binding": "test-bound-session" },
          credentials: "include",
        })
      ).status,
    origins.api
  );
  assert.equal(result, 204);
  assert.deepEqual(observed, [
    { method: "OPTIONS", verified: true, cookie: null },
    { method: "GET", verified: true, cookie: "__Host-fidy_session=synthetic" },
  ]);
  const mutation = await page.evaluate(
    async ({ api, id }) =>
      (
        await fetch(api + "/transactions/" + id, {
          method: "PUT",
          headers: {
            "content-type": "application/json",
            "fidy-session-binding": "test-bound-session",
          },
          body: JSON.stringify({ expectedRevision: 0, counterparty: "Referencia corregida" }),
          credentials: "include",
        })
      ).status,
    { api: origins.api, id: targetId }
  );
  assert.equal(mutation, 204);
  assert.deepEqual(observed.slice(2), [
    { method: "OPTIONS", verified: true, cookie: null },
    { method: "PUT", verified: true, cookie: "__Host-fidy_session=synthetic" },
  ]);
  const blocked = await page.evaluate(
    async (api) =>
      fetch(api + "/internal/release-smoke", { credentials: "include" }).then(
        () => false,
        () => true
      ),
    origins.api
  );
  assert.ok(blocked);
  assert.equal(observed.length, 4);
} finally {
  await browser?.close();
  await proxy.stop(true);
  await web.stop(true);
}
