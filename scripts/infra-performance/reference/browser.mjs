// Each invocation owns an isolated browser context and one newly seeded local installation.
import assert from "node:assert/strict";
import { appendFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { Schema } from "effect";
import { freshBudgetMonth, freshPendingReview } from "./fresh-workspaces.mjs";
import { freshDashboard, prepareReferenceDashboard } from "./fresh-dashboard.mjs";
import { freshRecurring, prepareReferenceRecurring } from "./fresh-recurring.mjs";
import { freshTransactions } from "./fresh-transactions.mjs";

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
    if (status !== success)
      process.stderr.write(`REFERENCE_HTTP ${response.request().method()} ${status}\n`);
    assert.equal(status, success, `Canonical request failed with HTTP ${status}`);
    assert.ok(backendMs > 0 && timing.responseEnd > 0, "Missing backend or transport timing");
    return Schema.decodeSync(Schema.fromJsonString(Schema.Unknown))(body.toString("utf8"));
  };
  if (process.env.FIDY_ASSESSMENT === "production") {
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
  const { before, startupMs, readMs, correctionMs } = await freshTransactions({
    page,
    ledger,
    api,
    calibration: process.env.FIDY_ASSESSMENT === "production",
    observe,
    observeStartup: async (reply) =>
      Schema.decodeSync(Schema.fromJsonString(Schema.Unknown))(await reply.text()),
    beforeRefresh: evidence,
  });
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
  assert.deepEqual(accountability, { reads: 2, corrections: 1, units: 0, receipts: 0 });
  const views = {};
  if (process.env.FIDY_ASSESSMENT === "production") {
    process.stderr.write("REFERENCE_STAGE budgets-month\n");
    const events = process.env.FIDY_REFERENCE_EVENTS;
    assert.ok(events, "Missing reference observation file");
    /** @param {Readonly<Record<string, unknown>>} row Bounded workspace measurement metadata. */
    const event = (row) => appendFileSync(events, JSON.stringify(row) + "\n");
    const input = { page, api, browser: app, event };
    views["budgets.month.browser"] = await freshBudgetMonth(input);
    process.stderr.write("REFERENCE_STAGE review-pending\n");
    views["review.pending.browser"] = await freshPendingReview(input);
    process.stderr.write("REFERENCE_STAGE dashboard-fresh\n");
    views["dashboard.fresh.browser"] = await freshDashboard(input);
    process.stderr.write("REFERENCE_STAGE recurring-fresh\n");
    Object.assign(views, await freshRecurring(input));
  }
  process.stdout.write(
    JSON.stringify({
      views,
      browser: browser.version(),
      startupMs,
      readMs,
      correctionMs,
      attempts,
      accountability,
    }) + "\n"
  );
} finally {
  await browser.close();
}
