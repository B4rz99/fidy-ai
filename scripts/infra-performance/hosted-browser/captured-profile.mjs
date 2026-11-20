// Drive the mounted application through its scoped web and API transports.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { join, resolve, sep } from "node:path";

import { mountCapturedTransactionHistory } from "../reference/fresh-transactions.mjs";

const { chromium } = await import("@playwright/test");
const success = 200,
  timeoutMs = 60000,
  intervalMs = 750;
const sum = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const sorted = (value) => {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(sorted);
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, sorted(value[key])])
  );
};
const capture = (value) =>
  Object.fromEntries(Object.entries(value ?? {}).map(([key, field]) => [key, sum(sorted(field))]));
const verifyInitial = (data, snapshots, expected) => {
  snapshots.contextTopLevel = Object.keys(data).sort();
  snapshots.initial = Object.keys(data.initial ?? {}).sort();
  snapshots.initialFields = capture(data.initial);
  assert.deepEqual(data.initial?.transactions?.page, expected);
};
const reviewCount = (data) => data.pendingCount ?? data.data?.pendingCount;
const verifyPayload = (url, data, { snapshots, workspace, expected }) => {
  if (url.pathname === "/web/session/binding" && url.search) {
    verifyInitial(data, snapshots, expected);
  }
  if (url.pathname === "/web/consent") snapshots.freshConsent = capture(data);
  if (url.pathname === "/user") {
    assert.deepEqual(data, workspace.profile);
    snapshots.profile = capture(data.data);
    snapshots.profileEnvelope = capture(data);
  }
  if (url.pathname === "/transactions") assert.deepEqual(data, expected);
  if (url.pathname === "/ingestion/review-workspace") {
    assert.deepEqual(data, workspace.review);
    snapshots.review = capture(data);
    snapshots.reviewCount = reviewCount(data);
  }
};
const server = (fetch) =>
  Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    idleTimeout: 45,
    error: () => new Response(null, { status: 502 }),
    tls: {
      cert: Bun.file(process.env.BROWSER_TLS_CERT),
      key: Bun.file(process.env.BROWSER_TLS_KEY),
    },
    fetch,
  });
const serveAsset = async (request, url, { assets, assetsDelivered }) => {
  const path = resolve(assets, "." + url.pathname);
  if (!path.startsWith(assets + sep)) return new Response(null, { status: 403 });
  const file = Bun.file(url.pathname === "/app/transactions" ? join(assets, "index.html") : path);
  if (!(await file.exists())) return new Response(null, { status: 404 });
  assetsDelivered.responses++;
  assetsDelivered.rawBytes += file.size;
  if (
    /(?:javascript|css|html)/.test(file.type) &&
    request.headers.get("accept-encoding")?.includes("gzip")
  ) {
    const bytes = Bun.gzipSync(await file.arrayBuffer());
    assetsDelivered.encodedBytes += bytes.byteLength;
    assetsDelivered.gzip++;
    return new Response(bytes, {
      headers: {
        "content-type": file.type,
        "content-encoding": "gzip",
        vary: "accept-encoding",
      },
    });
  }
  assetsDelivered.encodedBytes += file.size;
  return new Response(file);
};
const webTransport = ({ variant, origins, forwardWeb }, assetsDelivered) => {
  const assets = forwardWeb
    ? null
    : resolve(process.env[variant === "d1" ? "D1_WEB_ASSETS" : "NATIVE_WEB_ASSETS"]);
  return server(async (request) => {
    const url = new URL(request.url);
    if (request.method !== "GET" || url.origin !== origins.browser) {
      return new Response(null, { status: 403 });
    }
    if (!forwardWeb) return serveAsset(request, url, { assets, assetsDelivered });
    const reply = await forwardWeb(request);
    assetsDelivered.responses++;
    return reply;
  });
};
const allowedPaths = new Set([
  "/web/session/binding",
  "/web/consent",
  "/ingestion/review-workspace",
  "/transactions",
  "/user",
]);
const outsideProfile = (request, url, origins) =>
  url.origin !== origins.api ||
  request.headers.get("origin") !== origins.browser ||
  !["GET", "OPTIONS"].includes(request.method) ||
  !allowedPaths.has(url.pathname);
const apiTransport = (config, evidence) =>
  server(async (request) => {
    const { origins, forward, afterRequest } = config;
    const { events, report } = evidence;
    const url = new URL(request.url);
    if (outsideProfile(request, url, origins)) {
      events.push({
        rejected: request.method + " " + url.pathname,
        keys: [...url.searchParams.keys()],
      });
      await report();
      return new Response(null, { status: 403 });
    }
    const key = request.method + " " + url.pathname + url.search;
    const headersOut = new Headers(request.headers);
    for (const name of [
      "host",
      "connection",
      "content-length",
      "accept-encoding",
      "transfer-encoding",
    ]) {
      headersOut.delete(name);
    }
    const response = await forward(
      new Request(request.url, { headers: headersOut, method: request.method })
    );
    const ev = {
      route: key,
      status: response.status,
      origin: response.headers.get("access-control-allow-origin"),
      credentials: response.headers.get("access-control-allow-credentials"),
      hasCookie: request.headers.has("cookie"),
      hasBinding: request.headers.has("fidy-session-binding"),
    };
    events.push(ev);
    const bytes = await response.arrayBuffer();
    ev.bodyBytes = bytes.byteLength;

    if (response.ok && request.method === "GET") {
      verifyPayload(url, JSON.parse(new TextDecoder().decode(bytes)), {
        workspace: config.workspace,
        expected: config.expected,
        snapshots: evidence.snapshots,
      });
    }
    await afterRequest?.(key, response, ev);
    const headers = new Headers(response.headers);
    headers.delete("x-fidy-comparison-cost");
    return new Response(bytes.byteLength ? bytes : null, { status: response.status, headers });
  });
const launch = (origins, api, web) => {
  return chromium.launch({
    executablePath: process.env.ASSESSMENT_CHROMIUM,
    env: { HOME: process.env.HOME, PATH: process.env.PATH },
    args: [
      "--no-proxy-server",
      "--ignore-certificate-errors-spki-list=" + process.env.BROWSER_TLS_PIN,
      "--host-resolver-rules=MAP " +
        new URL(origins.api).hostname +
        ":443 127.0.0.1:" +
        api.port +
        ", MAP " +
        new URL(origins.browser).hostname +
        ":443 127.0.0.1:" +
        web.port +
        ", MAP * ~NOTFOUND, EXCLUDE localhost",
    ],
  });
};
const mountedPage = async (browser, { origins, cookie }, events) => {
  const context = await browser.newContext({
    timezoneId: "America/Bogota",
    serviceWorkers: "block",
  });
  await context.addCookies([
    {
      name: "__Host-fidy_session",
      value: cookie.slice("__Host-fidy_session=".length),
      url: origins.api,
      httpOnly: true,
      secure: true,
      sameSite: "Lax",
    },
  ]);
  const page = await context.newPage();
  page.on("requestfailed", (request) =>
    events.push({
      failed: request.method() + " " + new URL(request.url()).pathname,
      reason: request.failure()?.errorText,
    })
  );
  page.on("pageerror", (err) => events.push({ pageError: err.name }));
  page.setDefaultTimeout(timeoutMs);

  return page;
};
const responseFor = (page, path) =>
  page.waitForResponse(
    (reply) => reply.request().method() === "GET" && new URL(reply.url()).pathname === path
  );
const observeResponse = (events) => async (response) => {
  assert.equal(response.status(), success);
  const body = await response.body();
  if (
    response.request().method() === "GET" &&
    new URL(response.url()).pathname === "/transactions"
  ) {
    events.push({
      stage: "complete-http",
      milliseconds: response.request().timing().responseEnd,
      bodyBytes: body.byteLength,
    });
  }
  return JSON.parse(body.toString("utf8"));
};
const immediateTurn = (_index, action) => action();
const execute = async (
  page,
  { origins, expected, observations = 30, turn = immediateTurn },
  events
) => {
  const counts = responseFor(page, "/ingestion/review-workspace");
  const observe = observeResponse(events);
  const [mounted, review] = await Promise.all([
    mountCapturedTransactionHistory(
      {
        page,
        ledger: origins.browser + "/app/transactions?month=2026-11",
        api: origins.api,
        observe,
        observeStartup: observe,
      },
      expected
    ),
    counts,
  ]);
  await observe(review);
  events.push({ stage: "startup", complete: true, milliseconds: mounted.startupMs });

  const refresh = async (index) => {
    await turn(index, async () => {
      const profile = responseFor(page, "/user");
      const [milliseconds, response] = await Promise.all([mounted.refresh(), profile]);
      await observe(response);
      events.push({ stage: "refresh", complete: true, milliseconds });
    });
    await Bun.sleep(intervalMs);
  };
  await Array.from({ length: observations }, (_, index) => index).reduce(
    (previous, index) => previous.then(() => refresh(index)),
    Promise.resolve()
  );
};
export const runBrowser = async (config) => {
  const { variant, network = "ordinary" } = config;
  assert.equal(network, "ordinary");
  const dir = resolve(process.env.FIDY_DIAGNOSTIC_DIR);
  const events = [],
    snapshots = {};

  const assetsDelivered = { rawBytes: 0, encodedBytes: 0, responses: 0, gzip: 0 };
  const report = () =>
    Bun.write(
      join(dir, "ordinary-" + variant + ".json"),
      JSON.stringify({ variant, network, events, snapshots, assetsDelivered }, null, 2)
    );

  const web = webTransport(config, assetsDelivered);
  const api = apiTransport(config, { events, snapshots, report });
  let browser;
  try {
    browser = await launch(config.origins, api, web);
    await execute(await mountedPage(browser, config, events), config, events);
  } catch (err) {
    events.push({ stage: "incomplete", error: err.name });
    throw err;
  } finally {
    await report();
    await browser?.close();
    await web.stop(true);
    await api.stop(true);
  }
};
