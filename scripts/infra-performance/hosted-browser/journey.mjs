// The caller owns host admission, the fixture and its corresponding WebSession for each variant.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chromium } from "@playwright/test";
import { freshTransactions } from "../reference/fresh-transactions.mjs";
import { protectedBrowserProxy } from "./proxy.mjs";

export async function measureBrowser({ origins, environment, session, network, event, forward }) {
  assert.ok(["ordinary", "poor"].includes(network));
  const proxy = protectedBrowserProxy({
    origins,
    environment,
    forward,
    tls: {
      cert: Bun.file(process.env.BROWSER_TLS_CERT),
      key: Bun.file(process.env.BROWSER_TLS_KEY),
    },
  });
  let browser;
  try {
    browser = await chromium.launch({
      executablePath: process.env.ASSESSMENT_CHROMIUM,
      // Chrome and all of its child processes receive no runner credentials.
      env: { HOME: process.env.HOME, PATH: process.env.PATH, TMPDIR: process.env.RUNNER_TEMP },
      args: [
        "--no-proxy-server",
        "--ignore-certificate-errors-spki-list=" + process.env.BROWSER_TLS_PIN,
        "--host-resolver-rules=MAP " +
          new URL(origins.api).hostname +
          ":443 127.0.0.1:" +
          proxy.port,
      ],
    });
    const context = await browser.newContext({
      timezoneId: "America/Bogota",
      serviceWorkers: "block",
    });
    await context.addCookies([
      {
        name: "__Host-fidy_session",
        value: session,
        url: origins.api,
        secure: true,
        httpOnly: true,
        sameSite: "Lax",
      },
    ]);
    const page = await context.newPage();
    page.setDefaultTimeout(30000);
    const cdp = await context.newCDPSession(page);
    await cdp.send("Network.enable");
    if (network === "poor") {
      await cdp.send("Network.emulateNetworkConditions", {
        offline: false,
        latency: 400,
        downloadThroughput: 125000,
        uploadThroughput: 125000,
      });
    }
    event({
      type: "browser",
      version: browser.version(),
      profile: network,
      plannedJourneys: 3,
      network:
        network === "poor"
          ? { latencyMs: 400, bytesPerSecondEachDirection: 125000 }
          : { emulation: "off" },
      includes:
        "navigation or interaction through populated enabled content, with Chromium and upstream network time; provider signup precedes measurement",
      lifecycle: "unknown",
      load: "one active browser",
    });
    // Retain counts and encoded bytes only. URLs can include provider proof and User content.
    const resources = new Map();
    cdp.on("Network.responseReceived", ({ requestId, response }) => {
      const origin = new URL(response.url).origin;
      resources.set(requestId, {
        boundary: origin === origins.api ? "api" : origin === origins.browser ? "web" : "external",
        status: response.status,
      });
    });
    cdp.on("Network.loadingFinished", ({ requestId, encodedDataLength }) => {
      const metadata = resources.get(requestId);
      if (metadata) event({ type: "response", ...metadata, encodedBytes: encodedDataLength });
      resources.delete(requestId);
    });
    cdp.on("Network.loadingFailed", ({ requestId, canceled }) => {
      resources.delete(requestId);
      event({ type: "network-failure", canceled: canceled === true });
    });
    const observe = async (response) => {
      const body = await response.body();
      const request = response.request();
      event({
        type: "canonical",
        method: request.method(),
        status: response.status(),
        bodyBytes: body.length,
        httpMs: request.timing().responseEnd,
        payloadSha256: createHash("sha256").update(body).digest("hex"),
      });
      assert.equal(response.status(), 200);
      return JSON.parse(body.toString("utf8"));
    };
    await freshTransactions({
      page,
      ledger: origins.browser + "/app/transactions?month=2026-11",
      api: origins.api,
      calibration: true,
      observe,
      observeStartup: observe,
      beforeRefresh: async () => undefined,
      offered: (journey) => event({ type: "offered", journey }),
      completed: (journey, milliseconds) => event({ type: "completed", journey, milliseconds }),
    });
  } finally {
    await browser?.close();
    await proxy.stop(true);
  }
}
