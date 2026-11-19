import assert from "node:assert/strict";
import { Schema } from "effect";

export const targetId = "81000000-0000-4000-8000-000000000002";
const fixedId = targetId;
const afterName = "Referencia corregida";
const timeoutMs = 30_000;
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

function verifySeededPage(initial, calibration) {
  const productionPage = 7;
  const ordinaryPage = 25;
  assert.equal(initial.data.length, calibration ? productionPage : ordinaryPage);
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
  return target;
}

/** Both installations and the disposable reference run the same interaction and expected-state checks. */
export async function freshTransactions({
  page,
  ledger,
  api,
  calibration,
  observe,
  observeStartup,
  beforeRefresh,
  completed = () => {},
}) {
  const responseFor = (method, path) =>
    page.waitForResponse((reply) => {
      const url = new URL(reply.url());
      return reply.request().method() === method && url.origin === api && url.pathname === path;
    });
  // ResponseEnd is measured from Chromium request start through body completion. It never subtracts RTT.
  /** @param {string} label Expected visible counterparty. */
  const ready = async (label) => {
    const control = page.locator('[id="transaction-' + fixedId + '"]:enabled');
    await control.filter({ hasText: label }).waitFor();
    await page.evaluate(
      () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
    );
  };
  process.stderr.write("REFERENCE_STAGE bootstrap\n");
  const startupResponse = responseFor("GET", "/transactions");
  const booting = performance.now();
  await page.goto(ledger, { waitUntil: "commit" });
  await ready("Evaluación 2");
  const startupMs = performance.now() - booting;
  const startup = historyPage(await observeStartup(await startupResponse));
  verifySeededPage(startup, calibration);
  completed("startup", startupMs);
  const before = await beforeRefresh();
  process.stderr.write("REFERENCE_STAGE read\n");
  // Both builds disable search while history or Categories are stale, and keep it disabled on failure.
  // Arm the observer before the click so even a fast refresh must commit both DOM states.
  const search = page.getByRole("searchbox", { name: "Buscar transacciones", exact: true });
  assert.ok(await search.isEnabled());
  const refreshCycle = await page.evaluateHandle((timeout) => {
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
  const list = responseFor("GET", "/transactions");
  const started = performance.now();
  await page.getByRole("button", { name: "Actualizar transacciones", exact: true }).click();
  const initialResponse = await list;
  assert.ok(
    await refreshCycle.evaluate((cycle) => cycle.completed),
    "Refresh did not commit a fresh, editable history"
  );
  await ready("Evaluación 2");
  const readMs = performance.now() - started;
  await refreshCycle.dispose();
  const initial = historyPage(await observe(initialResponse));
  assert.deepEqual(initial, startup, "Refresh changed the seeded history");
  const target = verifySeededPage(initial, calibration);
  completed("refresh", readMs);
  process.stderr.write("REFERENCE_STAGE open-correction\n");
  await page.locator('[id="transaction-' + fixedId + '"]').click();
  const counterparty = page.getByRole("textbox", { name: "Contraparte", exact: true });
  const edit = page.getByRole("button", { name: "Editar transacción", exact: true });
  await counterparty.or(edit).first().waitFor({ state: "visible" });
  if (!(await counterparty.isVisible())) await edit.click();
  await counterparty.fill(afterName);
  process.stderr.write("REFERENCE_STAGE save\n");
  const save = responseFor("PUT", "/transactions/" + fixedId);
  const refresh = responseFor("GET", "/transactions");
  const saving = performance.now();
  await page.getByRole("button", { name: "Guardar", exact: true }).click();
  const saveResponse = await save;
  process.stderr.write("REFERENCE_STAGE fresh-read\n");
  const freshResponse = await refresh;
  await ready(afterName);
  const correctionMs = performance.now() - saving;
  const result = changedTransaction(await observe(saveResponse));
  const fresh = historyPage(await observe(freshResponse));
  const corrected = { ...target, counterparty: afterName, revision: 1 };
  assert.equal(result.data.id, fixedId);
  assert.equal(result.data.revision, 1);
  assert.deepEqual(fresh, {
    ...initial,
    data: initial.data.map((row) => (row.id === fixedId ? corrected : row)),
  });
  completed("correction", correctionMs);
  return { before, startupMs, readMs, correctionMs };
}
