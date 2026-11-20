// Each invocation owns an isolated browser context and one newly seeded local installation.
import assert from "node:assert/strict";
import { appendFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { Schema } from "effect";
import { freshBudgetMonth, freshPendingReview } from "./fresh-workspaces.mjs";
import { freshDashboard, prepareReferenceDashboard } from "./fresh-dashboard.mjs";
import { freshRecurring, prepareReferenceRecurring } from "./fresh-recurring.mjs";
import { freshTransactionHistory, freshTransactions } from "./fresh-transactions.mjs";
import { observeBrowserD1 } from "./browser-cost.mjs";

const { chromium } = await import("@playwright/test");

const pairingProof = Schema.decodeUnknownSync(
  Schema.Struct({
    publicCode: Schema.String,
    pairingId: Schema.String,
    privateVerifier: Schema.String,
  })
);
const counts = Schema.decodeUnknownSync(
  Schema.Struct({
    reads: Schema.Int,
    corrections: Schema.Int,
    units: Schema.Int,
    receipts: Schema.Int,
  })
);
const port = Number(process.env.REFERENCE_WEB_PORT ?? "4183");
const app = `https://127.0.0.1:${port}`;
const api = `https://127.0.0.1:${port + 1}`;
const operator = `http://127.0.0.1:${port + 2}`;
const readOnly = process.env.FIDY_REFERENCE_READ_ONLY === "1";
const ledger = app + "/app/transactions?month=2026-11";
/** @param {Uint8Array} body Exact response bytes used for comparison. */
const digest = (body) => createHash("sha256").update(body).digest("hex");
process.stderr.write("REFERENCE_STAGE launch\n");
const browser = await chromium.launch({
  ...(process.env.ASSESSMENT_CHROMIUM ? { executablePath: process.env.ASSESSMENT_CHROMIUM } : {}),
  args: ["--ignore-certificate-errors"],
});
try {
  const context = await browser.newContext({
    ignoreHTTPSErrors: true,
    timezoneId: "America/Bogota",
  });
  const page = await context.newPage();
  page.on("response", (reply) => {
    const url = new URL(reply.url());
    if (url.origin === api) {
      process.stderr.write(`${reply.request().method()} ${url.pathname} ${reply.status()}\n`);
    }
  });
  const timeoutMs = 30_000;
  page.setDefaultTimeout(timeoutMs);
  const { request } = context;
  const origin = { origin: app };
  /** @param {import("@playwright/test").APIResponse} reply Fixture or Login response. */
  const setup = (reply) => {
    if (!reply.ok()) process.stderr.write(`REFERENCE_HTTP ${reply.status()}\n`);
    assert.ok(reply.ok(), "Setup request failed");
    return reply;
  };
  process.stderr.write("REFERENCE_STAGE pairing\n");
  const pairingResponse = setup(await request.post(api + "/web/pairings", { headers: origin }));
  const pairing = pairingProof(await pairingResponse.json());
  process.stderr.write("REFERENCE_STAGE approval\n");
  setup(
    await request.post(operator + "/approve", {
      params: { code: pairing.publicCode, navigationDashboard: "true" },
    })
  );
  process.stderr.write("REFERENCE_STAGE redeem\n");
  setup(
    await request.post(api + "/web/pairings/redeem", {
      headers: origin,
      data: { pairingId: pairing.pairingId, privateVerifier: pairing.privateVerifier },
    })
  );
  const cdp = await context.newCDPSession(page);
  if (process.env.FIDY_ASSESSMENT_NETWORK === "poor") {
    await cdp.send("Network.enable");
    await cdp.send("Network.emulateNetworkConditions", {
      offline: false,
      latency: 400,
      downloadThroughput: 125000,
      uploadThroughput: 125000,
    });
  }
  const evidence = async () => {
    const reply = setup(await request.get(operator + "/assessment/accountability"));
    return counts(await reply.json());
  };
  /** @type {Array<{ status: number, bytes: number, backendMs: number, httpMs: number, startEpochMs: number, payload: string }>} */
  const attempts = [];
  /** @param {import("@playwright/test").Response} response Measured canonical response. */
  const observe = async (response) => {
    const body = await response.body();
    const headers = await response.allHeaders();
    const timing = response.request().timing();
    const backendMs = Number(headers["x-reference-backend-ms"]);
    const status = response.status();
    attempts.push({
      status,
      bytes: body.length,
      backendMs,
      httpMs: timing.responseEnd,
      startEpochMs: timing.startTime,
      payload: digest(body),
    });
    process.stderr.write(JSON.stringify(attempts.at(-1)) + "\n");
    const success = 200;
    if (status !== success) {
      process.stderr.write(`REFERENCE_HTTP ${response.request().method()} ${status}\n`);
    }
    assert.equal(status, success, `Canonical request failed with HTTP ${status}`);
    assert.ok(backendMs > 0 && timing.responseEnd > 0, "Missing backend or transport timing");
    return Schema.decodeSync(Schema.fromJsonString(Schema.Unknown))(body.toString("utf8"));
  };
  if (process.env.FIDY_ASSESSMENT === "production" && !readOnly) {
    process.stderr.write("REFERENCE_STAGE dashboard-fixture\n");
    assert.equal(new URL(api).hostname, "127.0.0.1");
    const binding = await request.get(api + "/web/session/binding", { headers: origin });
    const observed = Schema.decodeUnknownSync(Schema.Struct({ binding: Schema.NonEmptyString }))(
      await setup(binding).json()
    );
    const installation = { api, headers: { ...origin, "fidy-session-binding": observed.binding } };
    await prepareReferenceDashboard(request, installation);
    process.stderr.write("REFERENCE_STAGE recurring-fixture\n");
    await prepareReferenceRecurring(request, installation);
  }
  const events = process.env.FIDY_REFERENCE_EVENTS;
  assert.ok(events, "Missing reference observation file");
  /** @param {Readonly<Record<string, unknown>>} row Bounded workspace measurement metadata. */
  const event = (row) => appendFileSync(events, JSON.stringify(row) + "\n");
  const checkpoint =
    process.env.FIDY_REFERENCE_D1_COST === "1"
      ? observeBrowserD1(page, { api, operator }, event)
      : undefined;
  await checkpoint?.("before-startup");
  const idleMs = Number(process.env.FIDY_REFERENCE_SETUP_IDLE_MS ?? "0");
  const settledSetupMs = 2000;
  assert.ok(idleMs === 0 || idleMs === settledSetupMs);
  if (idleMs > 0) {
    const started = performance.now();
    // Allow one timer tick for rounding; verify the actual interval before navigation.
    await sleep(idleMs + 1);
    const elapsedMs = performance.now() - started;
    assert.ok(elapsedMs >= idleMs);
    event({ stage: "post-setup-idle", elapsedMs });
  }
  if (process.env.FIDY_REFERENCE_FULL_RECURRING === "1") {
    assert.equal(process.env.FIDY_ASSESSMENT, "extreme");
    process.stderr.write("REFERENCE_STAGE recurring-fresh\n");
    const before = await evidence();
    const views = await freshRecurring({ page, api, browser: app, event }, true);
    const after = await evidence();
    const accountability = {
      reads: after.reads - before.reads,
      corrections: after.corrections - before.corrections,
      units: after.units - before.units,
      receipts: after.receipts - before.receipts,
    };
    assert.equal(accountability.corrections, 0);
    assert.equal(accountability.units, 0);
    assert.equal(accountability.receipts, 0);
    process.stdout.write(
      JSON.stringify({ views, accountability, attempts, browser: browser.version() }) + "\n"
    );
  } else {
    const journeys = {
      startup: "startup.browser",
      refresh: "read.browser",
      correction: "correction.browser",
    };
    const journey = readOnly ? freshTransactionHistory : freshTransactions;
    const result = await journey({
      page,
      ledger,
      api,
      calibration: process.env.FIDY_ASSESSMENT === "production",
      observe,
      observeStartup: async (reply) =>
        Schema.decodeSync(Schema.fromJsonString(Schema.Unknown))(await reply.text()),
      beforeRefresh: evidence,
      checkpoint,
      offered: (stage) => event({ type: "offered", journey: journeys[stage] }),
      completed: (stage, milliseconds) =>
        event({ type: "completed", journey: journeys[stage], milliseconds }),
    });
    const { before, startupMs, readMs } = result;
    process.stderr.write("REFERENCE_STAGE accountability-after\n");
    const after = await evidence();
    const accountability = {
      reads: after.reads - before.reads,
      corrections: after.corrections - before.corrections,
      units: after.units - before.units,
      receipts: after.receipts - before.receipts,
    };
    process.stderr.write(JSON.stringify(accountability) + "\n");
    // WebSession requests in the pinned baseline write session Audit and carry no external retry key.
    assert.deepEqual(accountability, {
      reads: readOnly ? 1 : 2,
      corrections: readOnly ? 0 : 1,
      units: 0,
      receipts: 0,
    });
    const views = {};
    if (process.env.FIDY_ASSESSMENT === "production" && !readOnly) {
      process.stderr.write("REFERENCE_STAGE budgets-month\n");
      const input = { page, api, browser: app, event };
      views["budgets.month.browser"] = await freshBudgetMonth(input);
      await checkpoint?.("budgets");
      process.stderr.write("REFERENCE_STAGE review-pending\n");
      views["review.pending.browser"] = await freshPendingReview(input);
      await checkpoint?.("needs-review");
      process.stderr.write("REFERENCE_STAGE dashboard-fresh\n");
      views["dashboard.fresh.browser"] = await freshDashboard(input);
      await checkpoint?.("dashboard");
      process.stderr.write("REFERENCE_STAGE recurring-fresh\n");
      Object.assign(views, await freshRecurring(input));
      await checkpoint?.("recurring");
    }
    if (process.env.FIDY_ASSESSMENT === "extreme" && !readOnly) {
      const count = 5000,
        nextPage = 50;
      const input = { page, api, browser: app, event };
      process.stderr.write("REFERENCE_STAGE review-pending\n");
      views["review.pending.browser"] = await freshPendingReview(input, count);
      views["review.next.browser"] = await freshPendingReview(input, count, nextPage);
    }
    process.stdout.write(
      JSON.stringify({
        views,
        browser: browser.version(),
        startupMs,
        readMs,
        ...("correctionMs" in result ? { correctionMs: result.correctionMs } : {}),
        attempts,
        accountability,
      }) + "\n"
    );
  }
} finally {
  await browser.close();
}
