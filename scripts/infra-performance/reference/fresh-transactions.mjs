import assert from "node:assert/strict";
import { Schema } from "effect";

export const targetId = "81000000-0000-4000-8000-000000000002";
const afterName = "Referencia corregida";
const timeoutMs = 30_000;
const productionPage = 7,
  ordinaryPage = 25,
  idWidth = 12,
  minuteMs = 60000;
/** @typedef {import("@playwright/test").Page} Page */
/** @typedef {import("@playwright/test").Response} BrowserResponse */
/** @typedef {"startup" | "refresh" | "correction"} Stage */
/** @typedef {{page: Page, ledger: string, api: string, calibration: boolean,
 * observe: (reply: BrowserResponse) => Promise<unknown>, observeStartup: (reply: BrowserResponse) => Promise<unknown>,
 * offered?: (stage: Stage) => void, completed?: (stage: Stage, milliseconds: number) => void}} Journey */
const extraFields = Schema.Record(Schema.String, Schema.Unknown);
const transaction = Schema.StructWithRest(
  Schema.Struct({
    id: Schema.String,
    revision: Schema.Int,
    counterparty: Schema.NullOr(Schema.String),
    occurredAt: Schema.String,
    createdAt: Schema.String,
    categoryId: Schema.String,
    direction: Schema.String,
    money: Schema.StructWithRest(
      Schema.Struct({ amount: Schema.String, currency: Schema.String }),
      [extraFields]
    ),
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

/** @param {boolean} calibration */
const expectedRows = (calibration) => {
  return Array.from({ length: calibration ? productionPage : ordinaryPage }, (_, index) => {
    const ordinal = index === 0 ? 0 : index + 1;
    return {
      id: "81000000-0000-4000-8000-" + String(ordinal).padStart(idWidth, "0"),
      label: "Evaluación " + ordinal,
    };
  });
};

/** @param {ReturnType<typeof historyPage>} initial @param {boolean} calibration */
const verifySeededPage = (initial, calibration) => {
  assert.equal(initial.data.length, calibration ? productionPage : ordinaryPage);
  assert.deepEqual(
    initial.data.map((record) => record.id),
    expectedRows(calibration).map((row) => row.id)
  );
  if (calibration) {
    for (const [index, row] of initial.data.entries()) {
      const ordinal = index === 0 ? 0 : index + 1;
      assert.equal(row.counterparty, "Evaluación " + ordinal);
      assert.equal(row.revision, 0);
      assert.equal(row.direction, "outflow");
      assert.deepEqual(row.money, { amount: "1000", currency: ordinal % 2 === 0 ? "COP" : "USD" });
      const category = ordinal % 3 === 0 ? 1 : ordinal + 2;
      assert.equal(
        row.categoryId,
        "10000000-0000-4000-8000-" + String(category).padStart(idWidth, "0")
      );
      const timestamp = Date.parse("2026-11-17T12:00:00Z") - ordinal * minuteMs;
      assert.equal(Date.parse(row.occurredAt), timestamp);
      assert.equal(Date.parse(row.createdAt), timestamp);
    }
  }
  const target = initial.data.find((row) => row.id === targetId);
  assert.ok(target, "Seeded Transaction missing from initial page");
  assert.equal(target.counterparty, "Evaluación 2");
  assert.equal(target.revision, 0);
  return target;
};

const bootstrap = Schema.decodeUnknownSync(
  Schema.Struct({
    initial: Schema.Struct({ transactions: Schema.Struct({ page: Schema.Unknown }) }),
  })
);
/** @param {Journey} input @param {string} method @param {string} path */
const responseFor = ({ page, api }, method, path) =>
  page.waitForResponse((reply) => {
    const url = new URL(reply.url());
    return reply.request().method() === method && url.origin === api && url.pathname === path;
  });
// ResponseEnd is measured from Chromium request start through body completion. It never subtracts RTT.
/** @param {Journey} input @param {string} label Expected visible counterparty. */
const ready = async ({ page, calibration }, label) => {
  const expected = expectedRows(calibration).map((row) =>
    row.id === targetId ? { ...row, label } : row
  );
  await page.waitForFunction((rows) => {
    const controls = document.querySelectorAll(
      'button[data-transaction-slot="transaction-identity-control"]'
    );
    return (
      controls.length === rows.length &&
      rows.every((row, index) => {
        const control = controls[index];
        return (
          control.id === "transaction-" + row.id &&
          control.matches(":enabled") &&
          control.getClientRects().length > 0 &&
          control.textContent.includes(row.label)
        );
      })
    );
  }, expected);
  await page.evaluate(
    () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
  );
};
/** @param {Journey} input */
const startApplication = async (input) => {
  const { page, ledger, api, calibration, observeStartup, offered, completed } = input;
  process.stderr.write("REFERENCE_STAGE bootstrap\n");
  // The first page may arrive inside the real session bootstrap. An explicit historical
  // month can instead require a canonical read. Inspect only responses the app requested.
  /** @type {BrowserResponse[]} */
  const startupResponses = [];
  /** @param {BrowserResponse} reply */
  const captureStartup = (reply) => {
    const url = new URL(reply.url());
    if (reply.request().method() !== "GET" || url.origin !== api) return;
    if (
      url.pathname === "/transactions" ||
      (url.pathname === "/web/session/binding" &&
        url.searchParams.get("context") === "transactions")
    ) {
      startupResponses.push(reply);
    }
  };
  page.on("response", captureStartup);
  offered?.("startup");
  const booting = performance.now();
  await page.goto(ledger, { waitUntil: "commit" });
  await ready(input, "Evaluación 2");
  const startupMs = performance.now() - booting;
  page.off("response", captureStartup);
  const direct = startupResponses.findLast(
    (reply) => new URL(reply.url()).pathname === "/transactions"
  );
  const reply = direct ?? startupResponses.at(-1);
  assert.ok(reply, "Application startup did not load Transaction history");
  const context = await observeStartup(reply);
  const startup = historyPage(direct ? context : bootstrap(context).initial.transactions.page);
  verifySeededPage(startup, calibration);
  completed?.("startup", startupMs);
  return { startup, startupMs };
};

/** @param {Page} page */
const watchRefresh = async (page) => {
  // Both builds disable search while history or Categories are stale, and keep it disabled on failure.
  // Arm the observer before the click so even a fast refresh must commit both DOM states.
  const search = page.getByRole("searchbox", { name: "Buscar transacciones", exact: true });
  assert.ok(await search.isEnabled());
  return await page.evaluateHandle((timeout) => {
    const selector = 'input[aria-label="Buscar transacciones"]';
    const completed = new Promise((resolve) => {
      let pending = false;
      const observer = new MutationObserver(() => {
        const field = document.querySelector(selector);
        if (field?.matches(":disabled")) pending = true;
        if (pending && field?.matches(":enabled")) {
          clearTimeout(timer);
          observer.disconnect();
          resolve(true);
        }
      });
      const timer = setTimeout(() => {
        observer.disconnect();
        resolve(false);
      }, timeout);
      observer.observe(document.body, {
        attributes: true,
        attributeFilter: ["disabled"],
        childList: true,
        subtree: true,
      });
    });
    return { completed };
  }, timeoutMs);
};
/** @param {Journey} input @param {ReturnType<typeof historyPage>} startup */
const refreshHistory = async (input, startup) => {
  const { page, calibration, observe, offered, completed } = input;
  process.stderr.write("REFERENCE_STAGE read\n");
  const refreshCycle = await watchRefresh(page);
  const list = responseFor(input, "GET", "/transactions");
  offered?.("refresh");
  const started = performance.now();
  await page.getByRole("button", { name: "Actualizar transacciones", exact: true }).click();
  const initialResponse = await list;
  assert.ok(
    await refreshCycle.evaluate((cycle) => cycle.completed),
    "Refresh did not commit a fresh, editable history"
  );
  await ready(input, "Evaluación 2");
  const readMs = performance.now() - started;
  await refreshCycle.dispose();
  const initial = historyPage(await observe(initialResponse));
  assert.deepEqual(initial, startup, "Refresh changed the seeded history");
  const target = verifySeededPage(initial, calibration);
  completed?.("refresh", readMs);
  return { initial, target, readMs };
};
/** @param {Journey} input @param {Awaited<ReturnType<typeof refreshHistory>>} history */
const correctHistory = async (input, { initial, target }) => {
  const { page, observe, offered, completed } = input;
  process.stderr.write("REFERENCE_STAGE open-correction\n");
  await page.locator('[id="transaction-' + targetId + '"]').click();
  const counterparty = page.getByRole("textbox", { name: "Contraparte", exact: true });
  const edit = page.getByRole("button", { name: "Editar transacción", exact: true });
  await counterparty.or(edit).first().waitFor({ state: "visible" });
  if (!(await counterparty.isVisible())) await edit.click();
  await counterparty.fill(afterName);
  process.stderr.write("REFERENCE_STAGE save\n");
  const save = responseFor(input, "PUT", "/transactions/" + targetId);
  const refresh = responseFor(input, "GET", "/transactions");
  offered?.("correction");
  const saving = performance.now();
  await page.getByRole("button", { name: "Guardar", exact: true }).click();
  const saveResponse = await save;
  process.stderr.write("REFERENCE_STAGE fresh-read\n");
  const freshResponse = await refresh;
  await ready(input, afterName);
  const correctionMs = performance.now() - saving;
  const result = changedTransaction(await observe(saveResponse));
  const fresh = historyPage(await observe(freshResponse));
  const corrected = { ...target, counterparty: afterName, revision: 1 };
  assert.equal(result.data.id, targetId);
  assert.equal(result.data.revision, 1);
  assert.deepEqual(fresh, {
    ...initial,
    data: initial.data.map((row) => (row.id === targetId ? corrected : row)),
  });
  completed?.("correction", correctionMs);
  return correctionMs;
};
/**
 * @template Evidence
 * @param {Journey & {beforeRefresh: () => Promise<Evidence>}} input
 */
export const freshTransactions = async (input) => {
  const { startup, startupMs } = await startApplication(input);
  const before = await input.beforeRefresh();
  const history = await refreshHistory(input, startup);
  const correctionMs = await correctHistory(input, history);
  return { before, startupMs, readMs: history.readMs, correctionMs };
};
