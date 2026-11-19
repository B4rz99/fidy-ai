import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { Schema } from "effect";

/** @typedef {import("@playwright/test").Page} Page */
/** @typedef {import("@playwright/test").Response} BrowserResponse */
/** @typedef {{page: Page, api: string, browser: string, event: (row: Readonly<Record<string, unknown>>) => void}} Workspace */
const categories = 16,
  cap = "100000",
  width = 12,
  success = 200;
const currencies = ["COP", "USD"];
const money = Schema.Struct({ amount: Schema.String, currency: Schema.String });
const budgetReport = Schema.decodeUnknownSync(
  Schema.Struct({
    data: Schema.Struct({
      period: Schema.Struct({ from: Schema.String, to: Schema.String, timeZone: Schema.String }),
      statuses: Schema.Array(
        Schema.Struct({
          budget: Schema.Struct({
            id: Schema.String,
            categoryId: Schema.String,
            groupName: Schema.String,
            cap: money,
          }),
          type: Schema.String,
          spent: money,
          remaining: money,
        })
      ),
    }),
  })
);
const wire = Schema.decodeSync(Schema.fromJsonString(Schema.Unknown));
/**
 * @param {BrowserResponse} reply Actual measured response.
 */
const consumed = async (reply) => {
  const body = await reply.body();
  assert.equal(reply.status(), success);
  return {
    value: wire(body.toString("utf8")),
    http: {
      status: reply.status(),
      bytes: body.length,
      httpMs: reply.request().timing().responseEnd,
      digest: createHash("sha256").update(body).digest("hex"),
    },
  };
};
/**
 * @param {Workspace} input Installed application and evidence sink.
 * @param {string} path Expected canonical operation.
 * @param {Record<string, string>} query Required query parameters.
 */
const responseFor = ({ page, api }, path, query) =>
  page.waitForResponse((reply) => {
    const url = new URL(reply.url());
    return (
      reply.request().method() === "GET" &&
      url.origin === api &&
      url.pathname === path &&
      Object.entries(query).every(([name, value]) => url.searchParams.get(name) === value)
    );
  });
/** @param {Page} page Mounted browser page. */
const painted = (page) =>
  page.evaluate(
    () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
  );
/** @param {number} ordinal Fixture record ordinal. */
const digits = (ordinal) => String(ordinal).padStart(width, "0");
/** @param {unknown} value Actual November status response. */
const verifyBudgets = (value) => {
  const { period, statuses } = budgetReport(value).data;
  assert.equal(Date.parse(period.from), Date.parse("2026-11-01T05:00:00Z"));
  assert.equal(Date.parse(period.to), Date.parse("2026-12-01T05:00:00Z"));
  assert.equal(period.timeZone, "America/Bogota");
  assert.equal(statuses.length, currencies.length * categories);
  // Seven effective outflows after one Reconciliation. Category 1 has two COP outflows and one USD outflow.
  const outflows = [
    new Map([
      [1, "2000"],
      [4, "1000"],
      [6, "1000"],
    ]),
    new Map([
      [1, "1000"],
      [7, "1000"],
      [9, "1000"],
    ]),
  ];
  for (const [index, currency] of currencies.entries()) {
    for (let category = 1; category <= categories; category++) {
      const id = "82000000-0000-4000-8000-" + digits(index * categories + category);
      const row = statuses.find(({ budget }) => budget.id === id);
      assert.ok(row, "Missing seeded Budget");
      assert.equal(row.budget.categoryId, "10000000-0000-4000-8000-" + digits(category));
      assert.equal(row.budget.groupName, "Grupo " + currency);
      assert.deepEqual(row.budget.cap, { amount: cap, currency });
      assert.equal(row.type, "under");
      const amount = outflows[index].get(category) ?? "0";
      assert.deepEqual(row.spent, { amount, currency });
      assert.deepEqual(row.remaining, { amount: String(Number(cap) - Number(amount)), currency });
    }
  }
};
/**
 * @param {Page} page Mounted browser page.
 * @param {string[]} totals Expected spend per group in declared Currency order.
 */
const usableBudgets = async (page, totals) => {
  for (const [index, currency] of currencies.entries()) {
    const group = page.getByRole("region", {
      name: "Grupo Grupo " + currency + " " + currency,
      exact: true,
    });
    const spend = group
      .locator(".budget-group-figures .budget-value")
      .filter({ hasText: "Gastado" });
    await spend.filter({ hasText: new RegExp(totals[index] + "(?:,00)?(?:\\s|$)") }).waitFor();
    await page.waitForFunction(
      ({ currency, count }) => {
        const section = document.querySelector(
          '[aria-label="Grupo Grupo ' + currency + " " + currency + '"]'
        );
        const fields = section?.querySelectorAll('input[aria-label^="Presupuesto de "]:enabled');
        return (
          fields?.length === count && [...fields].every((item) => item.getClientRects().length > 0)
        );
      },
      { currency, count: categories }
    );
  }
  await painted(page);
};

/** @param {Workspace} input Installed application and evidence sink. */
export const freshBudgetMonth = async (input) => {
  const { page, browser, event } = input;
  await page.goto(browser + "/app/budgets?month=2026-10", { waitUntil: "commit" });
  await usableBudgets(page, ["0", "0"]);
  const response = responseFor(input, "/budget-status", {
    month: "2026-11",
    timeZone: "America/Bogota",
  });
  const journey = "budgets.month.browser";
  event({ type: "offered", journey });
  const start = performance.now();
  await page.getByRole("button", { name: "Mes siguiente", exact: true }).click();
  const reply = await response;
  await usableBudgets(page, ["4[.]?000", "3[.]?000"]);
  const milliseconds = performance.now() - start;
  const { value, http } = await consumed(reply);
  verifyBudgets(value);
  event({ type: "completed", journey, milliseconds, http });
  return { milliseconds, http };
};
