import assert from "node:assert/strict";
import { Schema } from "effect";
import { RecurringWorkspace } from "../../../apps/server/src/shell/recurring-plans/contract";
import { consumed, painted, responseFor } from "./fresh-workspaces.mjs";

/** @typedef {import("./fresh-workspaces.mjs").Workspace} Workspace */
/** @typedef {import("@playwright/test").Page} Page */
const route = "/recurring-plans",
  month = "2026-11",
  compact = { month, view: "compact" };
const ids = ["83000000-0000-4000-8000-000000000000", "83000000-0000-4000-8000-000000000001"];
const names = ["Recurrente 0", "Recurrente 1"];
const dateHistory = ["2018-01-01", "2018-02-01"];
const money = Schema.Struct({ amount: Schema.String, currency: Schema.String });
const plan = Schema.Struct({
  name: Schema.String,
  currency: Schema.String,
  kind: Schema.String,
  frequency: Schema.String,
  firstDate: Schema.String,
  counterparty: Schema.String,
  money,
});
const occurrence = Schema.Struct({
  planId: Schema.String,
  expectedDate: Schema.String,
  plan,
  completed: money,
  remaining: money,
});
const complete = Schema.decodeUnknownSync(Schema.Struct({ data: RecurringWorkspace }));
const encoded = Schema.decodeUnknownSync(
  Schema.Struct({
    data: Schema.Struct({
      month: Schema.String,
      occurrences: Schema.Array(occurrence),
      previous: Schema.Array(occurrence),
      document: Schema.Struct({
        plans: Schema.Array(
          Schema.Struct({
            id: Schema.String,
            revisions: Schema.Array(Schema.Struct({ from: Schema.String, plan })),
          })
        ),
      }),
    }),
  })
);
/** @param {number} index Seeded plan ordinal. @param {string} firstDate Beginning of the verified revision. */
const fixturePlan = (index, firstDate) => ({
  name: names[index],
  currency: "COP",
  kind: "expense",
  frequency: "monthly",
  firstDate,
  counterparty: "Contraparte " + index,
  money: { amount: "100000", currency: "COP" },
});
/** @param {string} period Requested calendar month. @param {number[]} selected Expected plans after filtering. */
const expected = (period, selected) =>
  selected.map((index) => ({
    planId: ids[index],
    expectedDate: period + "-01",
    plan: fixturePlan(index, dateHistory[1]),
    completed: { amount: "0", currency: "COP" },
    remaining: { amount: "100000", currency: "COP" },
  }));
/**
 * @param {unknown} value Full wire response.
 * @param {{selected:number[],prior:string,full?:boolean}} cell Expected filter, prior month and revision projection.
 */
const verify = (value, { selected, prior, full }) => {
  complete(value);
  const data = encoded(value).data;
  assert.equal(data.month, month);
  const dates = full ? dateHistory : [dateHistory[1]];
  assert.deepEqual(
    data.document.plans,
    ids.map((id, index) => ({
      id,
      revisions: dates.map((from) => ({ from, plan: fixturePlan(index, from) })),
    }))
  );
  assert.deepEqual(data.occurrences, expected(month, selected));
  assert.deepEqual(data.previous, expected(prior, selected));
};
/**
 * @param {Page} page Mounted Recurring application.
 * @param {string} period Expected calendar month.
 * @param {number[]} selected Expected visible plans.
 */
const usable = async (page, period, selected) => {
  await page.waitForFunction(
    ({ period, names }) => {
      const date = period + "-01";
      const shortDate = new Intl.DateTimeFormat("es-CO", {
        day: "numeric",
        month: "short",
        timeZone: "UTC",
      }).format(new Date(date + "T12:00:00Z"));
      const rows = [
        ...document.querySelectorAll(
          '[data-recurring-slot="occurrence-group"] tr[tabindex="0"],[data-recurring-slot="occurrence-group"] button:not([aria-expanded])'
        ),
      ].filter(
        (row) =>
          row.getClientRects().length > 0 &&
          (row.getAttribute("aria-label")?.includes(date) || row.textContent.includes(shortDate))
      );
      return (
        rows.length === names.length &&
        names.every((name) => rows.some((row) => row.textContent.includes(name)))
      );
    },
    { period, names: selected.map((index) => names[index]) }
  );
  await painted(page);
};
/** @param {Page} page Mounted monthly view. */
const earlierPanel = async (page) => {
  const section = page
    .locator("details")
    .filter({ has: page.locator("summary").filter({ hasText: "Pendientes de meses anteriores" }) });
  if ((await section.getAttribute("open")) === null) await section.locator("summary").click();
};
/**
 * @param {Workspace} input Installed origins and evidence sink.
 * @param {{journey:string,query:Record<string,string>, action:()=>Promise<void>, ready:()=>Promise<void>,selected:number[],prior:string}} cell Predeclared visible interaction.
 */
const measure = async (input, cell) => {
  const response = responseFor(input, route, cell.query);
  input.event({ type: "offered", journey: cell.journey });
  const start = performance.now();
  await cell.action();
  const reply = await response;
  await cell.ready();
  const milliseconds = performance.now() - start;
  const { value, http } = await consumed(reply);
  verify(value, cell);
  const result = { milliseconds, http };
  input.event({ type: "completed", journey: cell.journey, ...result });
  return { result, reply };
};
/**
 * @param {Workspace} input Installed origins and evidence sink.
 * @param {import("@playwright/test").Response} authority Actual bound request from this same mounted session.
 */
const fullHistory = async ({ page, api, event }, authority) => {
  const binding = await authority.request().headerValue("fidy-session-binding");
  assert.ok(binding, "Missing mounted WebSession binding");
  const url = api + route + "?month=" + month;
  const response = page.waitForResponse(
    (reply) => reply.request().method() === "GET" && reply.url() === url
  );
  const journey = "recurring.full.http";
  event({ type: "offered", journey });
  await page.evaluate(
    async ({ url, binding }) => {
      const reply = await fetch(url, {
        credentials: "include",
        headers: { "fidy-session-binding": binding },
      });
      await reply.arrayBuffer();
    },
    { url, binding }
  );
  const { value, http } = await consumed(await response);
  verify(value, { selected: [0, 1], prior: "2026-10", full: true });
  assert.ok(http.httpMs > 0);
  const result = { milliseconds: http.httpMs, http };
  event({ type: "completed", journey, ...result });
  return result;
};
/** @param {Workspace} input Installed origins and evidence sink. */
export const freshRecurring = async (input) => {
  const { page, browser } = input;
  const priming = responseFor(input, route, { month: "2026-10", view: "compact" });
  await page.goto(browser + "/app/recurring?month=2026-10", { waitUntil: "commit" });
  const primed = encoded((await consumed(await priming)).value).data;
  assert.deepEqual(primed.occurrences, expected("2026-10", [0, 1]));
  await usable(page, "2026-10", [0, 1]);
  const monthly = await measure(input, {
    journey: "recurring.month.browser",
    query: compact,
    selected: [0, 1],
    prior: "2026-10",
    action: () => page.getByRole("button", { name: "Mes siguiente", exact: true }).click(),
    ready: () => usable(page, month, [0, 1]),
  });
  const history = await fullHistory(input, monthly.reply);
  await earlierPanel(page);
  const prior = await measure(input, {
    journey: "recurring.previous.browser",
    query: { ...compact, previousMonth: "2026-09" },
    selected: [0, 1],
    prior: "2026-09",
    action: () =>
      page.getByRole("button", { name: "Consultar meses anteriores", exact: true }).click(),
    ready: async () => {
      await earlierPanel(page);
      await usable(page, "2026-09", [0, 1]);
    },
  });
  await page.getByRole("button", { name: "Filtros", exact: true }).click();
  await page.getByRole("textbox", { name: "Buscar recurrentes", exact: true }).fill(names[1]);
  const selective = await measure(input, {
    journey: "recurring.selective.browser",
    query: { ...compact, previousMonth: "2026-09", search: names[1] },
    selected: [1],
    prior: "2026-09",
    action: () => page.getByRole("button", { name: "Aplicar filtros", exact: true }).click(),
    ready: () => usable(page, month, [1]),
  });
  return {
    "recurring.month.browser": monthly.result,
    "recurring.previous.browser": prior.result,
    "recurring.selective.browser": selective.result,
    "recurring.full.http": history,
  };
};
