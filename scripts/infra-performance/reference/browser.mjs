// Each invocation owns an isolated browser context and one newly seeded local installation.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { Schema } from "effect";

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
const extraFields = Schema.Record(Schema.String, Schema.Unknown);
const transaction = Schema.StructWithRest(
  Schema.Struct({
    id: Schema.String,
    revision: Schema.Int,
    counterparty: Schema.NullOr(Schema.String),
  }),
  [extraFields]
);
const historyPage = Schema.decodeUnknownSync(
  Schema.StructWithRest(Schema.Struct({ data: Schema.Array(transaction) }), [extraFields])
);
const changedTransaction = Schema.decodeUnknownSync(
  Schema.Struct({
    data: Schema.Struct({ id: Schema.String, revision: Schema.Int }),
  })
);

const app = "https://127.0.0.1:4183";
const api = "https://127.0.0.1:4184";
const operator = "http://127.0.0.1:4185";
const ledger = app + "/app/transactions?month=2026-11";
const fixedId = "81000000-0000-4000-8000-000000000002";
const afterName = "Referencia corregida";
/** @param {Uint8Array} body Exact response bytes used for comparison. */
const digest = (body) => createHash("sha256").update(body).digest("hex");
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
    assert.ok(
      reply.ok(),
      `Setup returned HTTP ${reply.status()} for ${new URL(reply.url()).pathname}`
    );
    return reply;
  };
  const pairingResponse = setup(await request.post(api + "/web/pairings", { headers: origin }));
  const pairing = pairingProof(await pairingResponse.json());
  setup(
    await request.post(operator + "/approve", {
      params: { code: pairing.publicCode, navigationDashboard: "true" },
    })
  );
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
  /**
   * @param {string} method Expected HTTP method.
   * @param {string} path Expected canonical route.
   */
  const responseFor = (method, path) =>
    page.waitForResponse(
      (reply) => reply.request().method() === method && new URL(reply.url()).pathname === path
    );
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
    assert.equal(status, success, `Canonical request failed with HTTP ${status}`);
    assert.ok(backendMs > 0 && timing.responseEnd > 0, "Missing backend or transport timing");
    return Schema.decodeSync(Schema.fromJsonString(Schema.Unknown))(body.toString("utf8"));
  };
  // ResponseEnd is measured from Chromium request start through body completion. It never subtracts RTT.
  /** @param {string} label Expected visible counterparty. */
  const ready = async (label) => {
    const control = page.locator('[id="transaction-' + fixedId + '"]:enabled');
    await control.filter({ hasText: label }).waitFor();
    await page.evaluate(
      () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
    );
  };
  await page.goto(ledger);
  await ready("Evaluación 2");
  const before = await evidence();
  const list = responseFor("GET", "/transactions");
  const started = performance.now();
  await page.getByRole("button", { name: "Actualizar transacciones", exact: true }).click();
  const initial = historyPage(await observe(await list));
  await ready("Evaluación 2");
  const readMs = performance.now() - started;
  const productionPage = 7;
  const ordinaryPage = 25;
  assert.equal(
    initial.data.length,
    process.env.FIDY_ASSESSMENT === "production" ? productionPage : ordinaryPage
  );
  const ids = initial.data.map((record) => record.id);
  const expectedIds = initial.data.map((_, index) => {
    const ordinal = index === 0 ? 0 : index + 1;
    return "81000000-0000-4000-8000-" + String(ordinal).padStart("000000000000".length, "0");
  });
  assert.deepEqual(ids, expectedIds);
  const target = initial.data.find((row) => row.id === fixedId);
  assert.ok(target, "Seeded Transaction missing from initial page");
  assert.equal(target.counterparty, "Evaluación 2");
  assert.equal(target.revision, 0);
  await page.locator('[id="transaction-' + fixedId + '"]').click();
  await page.getByRole("textbox", { name: "Contraparte", exact: true }).fill(afterName);
  const save = responseFor("PUT", "/transactions/" + fixedId);
  const refresh = responseFor("GET", "/transactions");
  const saving = performance.now();
  await page.getByRole("button", { name: "Guardar", exact: true }).click();
  const result = changedTransaction(await observe(await save));
  const fresh = historyPage(await observe(await refresh));
  await ready(afterName);
  const correctionMs = performance.now() - saving;
  const corrected = { ...target, counterparty: afterName, revision: 1 };
  assert.equal(result.data.id, fixedId);
  assert.equal(result.data.revision, 1);
  assert.deepEqual(fresh, {
    ...initial,
    data: initial.data.map((row) => (row.id === fixedId ? corrected : row)),
  });
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
  process.stdout.write(
    JSON.stringify({ browser: browser.version(), readMs, correctionMs, attempts, accountability }) +
      "\n"
  );
} finally {
  await browser.close();
}
