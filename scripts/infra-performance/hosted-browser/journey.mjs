// The caller owns host admission, the fixture and its corresponding WebSession for each variant.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { Schema } from "effect";
import { freshDashboard } from "../reference/fresh-dashboard.mjs";
import { freshRecurring } from "../reference/fresh-recurring.mjs";
import { freshBudgetMonth, freshPendingReview } from "../reference/fresh-workspaces.mjs";
import { freshTransactions } from "../reference/fresh-transactions.mjs";
import { protectedBrowserProxy } from "./proxy.mjs";

const { chromium } = await import("@playwright/test");
/** @typedef {import("./proxy.mjs").Origins} Origins */
/** @typedef {"ordinary" | "poor"} Network */
/** @typedef {"transactions" | "budgets" | "needs-review" | "dashboard" | "recurring"} View */
/** @typedef {(row: Readonly<Record<string, unknown>>) => void} EventSink */
/** @typedef {import("@playwright/test").CDPSession} Cdp */
/** @typedef {import("@playwright/test").Response} BrowserResponse */
/** @typedef {Pick<import("./proxy.mjs").ProxySettings, "origins" | "environment" | "forward"> & {
 * session: string, network: Network, view: View, event: EventSink }} Inputs */
const timeoutMs = 30000,
  latencyMs = 400,
  bytesPerSecond = 125000,
  success = 200;
const json = Schema.decodeSync(Schema.fromJsonString(Schema.Unknown));
/**
 * @param {Origins} origins Installed web and API host pair.
 * @param {number} port Runner-local TLS listener port.
 */
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
/**
 * @param {import("@playwright/test").Browser} browser Chromium instance.
 * @param {Origins} origins Installed web and API host pair.
 * @param {string} session Host-only synthetic WebSession credential.
 */
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
/**
 * @param {Cdp} cdp DevTools session for the measured page.
 * @param {Network} network Predeclared network profile.
 */
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
/**
 * @param {string} origin Observed resource origin.
 * @param {Origins} origins Installed web and API host pair.
 */
const resourceBoundary = (origin, origins) => {
  if (origin === origins.api) return "api";
  return origin === origins.browser ? "web" : "external";
};
/**
 * @param {Cdp} cdp DevTools session for the measured page.
 * @param {Origins} origins Installed web and API host pair.
 * @param {EventSink} event Metadata-only evidence sink.
 */
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
/**
 * @param {EventSink} event Metadata-only evidence sink.
 * @param {BrowserResponse} response Observed browser response.
 */
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
/**
 * @param {EventSink} event Metadata-only evidence sink.
 * @param {Pick<Inputs, "network" | "view">} cell Predeclared browser view and network.
 * @param {string} version Chromium version reported by the executable.
 */
const recordBrowser = (event, { network, view }, version) => {
  event({
    type: "browser",
    version,
    profile: network,
    view,
    plannedJourneys: ["transactions", "recurring"].includes(view) ? 3 : 1,
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
/**
 * @param {Inputs} inputs Installed origins, WebSession, network and evidence sink.
 */
export const measureBrowser = async ({
  origins,
  environment,
  session,
  network,
  view,
  event,
  forward,
}) => {
  assert.ok(["ordinary", "poor"].includes(network));
  const proxy = protectedBrowserProxy({
    origins,
    environment,
    forward,
    transactionCorrection: view === "transactions",
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
    recordBrowser(event, { network, view }, browser.version());
    recordResources(cdp, origins, event);
    if (view !== "transactions") {
      const readers = {
        budgets: freshBudgetMonth,
        "needs-review": freshPendingReview,
        dashboard: freshDashboard,
        recurring: freshRecurring,
      };
      await readers[view]({ page, ...origins, event });
      return;
    }
    /**
     * @param {BrowserResponse} response Observed browser response.
     */
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
