// The caller owns host admission, the fixture and its corresponding WebSession for each variant.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { Schema } from "effect";
import { freshTransactions } from "../reference/fresh-transactions.mjs";
import { protectedBrowserProxy } from "./proxy.mjs";

const { chromium } = await import("@playwright/test");
/** @typedef {import("./proxy.mjs").Origins} Origins */
/** @typedef {"ordinary" | "poor"} Network */
/** @typedef {(row: Readonly<Record<string, unknown>>) => void} EventSink */
/** @typedef {import("@playwright/test").CDPSession} Cdp */
/** @typedef {import("@playwright/test").Response} BrowserResponse */
/** @typedef {Pick<import("./proxy.mjs").ProxySettings, "origins" | "environment" | "forward"> & {
 * session: string, network: Network, event: EventSink }} Inputs */
const timeoutMs = 30000,
  latencyMs = 400,
  bytesPerSecond = 125000,
  success = 200;
const json = Schema.decodeSync(Schema.fromJsonString(Schema.Unknown));
/** @param {Origins} origins @param {number} port */
const launch = (origins, port) =>
  chromium.launch({
    executablePath: process.env.ASSESSMENT_CHROMIUM,
    // Chrome and all of its child processes receive no runner credentials.
    env: { HOME: process.env.HOME, PATH: process.env.PATH, TMPDIR: process.env.RUNNER_TEMP },
    args: [
      "--no-proxy-server",
      "--ignore-certificate-errors-spki-list=" + process.env.BROWSER_TLS_PIN,
      "--host-resolver-rules=MAP " + new URL(origins.api).hostname + ":443 127.0.0.1:" + port,
    ],
  });
/** @param {import("@playwright/test").Browser} browser @param {Origins} origins @param {string} session */
const openPage = async (browser, origins, session) => {
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
  page.setDefaultTimeout(timeoutMs);
  return { page, context };
};
/** @param {Cdp} cdp @param {Network} network */
const setNetwork = async (cdp, network) => {
  await cdp.send("Network.enable");
  if (network === "poor") {
    await cdp.send("Network.emulateNetworkConditions", {
      offline: false,
      latency: latencyMs,
      downloadThroughput: bytesPerSecond,
      uploadThroughput: bytesPerSecond,
    });
  }
};
/** @param {string} origin @param {Origins} origins */
const resourceBoundary = (origin, origins) => {
  if (origin === origins.api) return "api";
  return origin === origins.browser ? "web" : "external";
};
/** @param {Cdp} cdp @param {Origins} origins @param {EventSink} event */
const recordResources = (cdp, origins, event) => {
  // Retain counts and encoded bytes only. URLs can include provider proof and User content.
  /** @type {Map<string, {boundary: string, status: number}>} */
  const resources = new Map();
  cdp.on("Network.responseReceived", ({ requestId, response }) => {
    const origin = new URL(response.url).origin;
    resources.set(requestId, {
      boundary: resourceBoundary(origin, origins),
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
};
/** @param {EventSink} event @param {BrowserResponse} response */
const observeResponse = async (event, response) => {
  const body = await response.body();
  const request = response.request();
  const bootstrap = new URL(response.url()).pathname === "/web/session/binding";
  event({
    type: bootstrap ? "bootstrap" : "canonical",
    method: request.method(),
    status: response.status(),
    bodyBytes: body.length,
    httpMs: request.timing().responseEnd,
    ...(bootstrap ? {} : { payloadSha256: createHash("sha256").update(body).digest("hex") }),
  });
  assert.equal(response.status(), success);
  return json(body.toString("utf8"));
};
/** @param {EventSink} event @param {Network} network @param {string} version */
const recordBrowser = (event, network, version) => {
  event({
    type: "browser",
    version,
    profile: network,
    plannedJourneys: 3,
    network:
      network === "poor"
        ? { latencyMs, bytesPerSecondEachDirection: bytesPerSecond }
        : { emulation: "off" },
    includes:
      "navigation or interaction through populated enabled content, with Chromium and upstream network time; provider signup precedes measurement",
    lifecycle: "unknown",
    load: "one active browser",
  });
};
/** @param {Inputs} inputs */
export const measureBrowser = async ({
  origins,
  environment,
  session,
  network,
  event,
  forward,
}) => {
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
    browser = await launch(origins, proxy.port);
    const { page, context } = await openPage(browser, origins, session);
    const cdp = await context.newCDPSession(page);
    await setNetwork(cdp, network);
    recordBrowser(event, network, browser.version());
    recordResources(cdp, origins, event);
    /** @param {BrowserResponse} response */
    const observe = (response) => observeResponse(event, response);
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
};
