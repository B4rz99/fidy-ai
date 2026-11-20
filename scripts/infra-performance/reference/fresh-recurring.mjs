import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { Schema } from "effect";
import { RecurringWorkspace } from "../../../apps/server/src/shell/recurring-plans/contract";
import { consumed, painted, responseFor } from "./fresh-workspaces.mjs";

/** @typedef {import("./fresh-workspaces.mjs").Workspace} Workspace */
/** @typedef {import("@playwright/test").Page} Page */
const route = "/recurring-plans",
  month = "2026-11",
  compact = { month, view: "compact" };
const ids = ["83000000-0000-4000-8000-000000000000", "83000000-0000-4000-8000-000000000001"];
const planCount = 100,
  revisionCount = 100,
  pageSize = 20,
  idDigits = 12,
  selectedFullPlan = 93,
  firstYear = 2018,
  calendarDateLength = 10,
  okStatus = 200;
const allPlans = Array.from({ length: planCount }, (_, index) => index);
const allRevisions = Array.from({ length: revisionCount }, (_, index) =>
  new Date(Date.UTC(firstYear, index, 1)).toISOString().slice(0, calendarDateLength)
);
/** @param {number} index Seeded plan ordinal. */
const planName = (index) => "Recurrente " + index;

const dateHistory = ["2018-01-01", "2018-02-01", "2018-03-01"];
const initialAmount = "100000",
  editedAmount = "123000",
  changed = 1;
const money = Schema.Struct({ amount: Schema.String, currency: Schema.String });
const plan = Schema.Struct({
  name: Schema.String,
  amountMode: Schema.String,
  timeZone: Schema.String,
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
const fixturePlan = (index, firstDate, fullSize = false) => ({
  name: planName(index),
  amountMode: "fixed",
  timeZone: "America/Bogota",
  currency: "COP",
  kind: "expense",
  frequency: "monthly",
  firstDate,
  counterparty: "Contraparte " + index,
  money: {
    amount: !fullSize && firstDate === dateHistory[2] ? editedAmount : initialAmount,
    currency: "COP",
  },
});
/** @param {string} period Requested calendar month. @param {number[]} selected Expected plans after filtering. */
const expected = (period, selected, fullSize = false) =>
  selected.map((index) => {
    const lastCalibration = index === changed ? dateHistory[2] : dateHistory[1];
    return {
      planId: "83000000-0000-4000-8000-" + String(index).padStart(idDigits, "0"),
      expectedDate: period + "-01",
      plan: fixturePlan(
        index,
        fullSize ? allRevisions[revisionCount - 1] : lastCalibration,
        fullSize
      ),
      completed: { amount: "0", currency: "COP" },
      remaining: {
        amount: !fullSize && index === changed ? editedAmount : initialAmount,
        currency: "COP",
      },
    };
  });
/**
 * @param {unknown} value Full wire response.
 * @param {{selected:number[],prior:string,full?:boolean,fullSize?:boolean}} cell Expected filter, prior month and revision projection.
 */
const verify = (value, { selected, prior, full, fullSize }) => {
  complete(value);
  const data = encoded(value).data;
  assert.equal(data.month, month);
  const revisions = [
    dateHistory.slice(0, 2),
    full ? dateHistory : [dateHistory[0], dateHistory[2]],
  ];
  const fullSizeRevisions = full
    ? allRevisions
    : [allRevisions[0], allRevisions[revisionCount - 1]];
  assert.deepEqual(
    data.document.plans,
    (fullSize ? allPlans : [0, 1]).map((index) => ({
      id: "83000000-0000-4000-8000-" + String(index).padStart(idDigits, "0"),
      revisions: (fullSize ? fullSizeRevisions : revisions[index]).map((from) => ({
        from,
        plan: fixturePlan(index, from, fullSize),
      })),
    }))
  );
  assert.deepEqual(data.occurrences, expected(month, selected, fullSize));
  assert.deepEqual(data.previous, expected(prior, selected, fullSize));
};
/**
 * @param {Page} page Mounted Recurring application.
 * @param {string} period Expected calendar month.
 * @param {number[]} selected Expected visible plans.
 */
const usable = async (page, period, selected) => {
  await page.waitForFunction(
    ({ period, names, total }) => {
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
          (row.getAttribute("aria-label")?.includes(date) ?? row.textContent.includes(shortDate))
      );
      return (
        (total === names.length ||
          rows[0]
            ?.closest("section")
            ?.querySelector("nav")
            ?.textContent.includes("1–" + names.length + " de " + total)) &&
        rows.length === names.length &&
        names.every(
          (name, index) =>
            rows[index].getAttribute("aria-label")?.startsWith(name + " " + date + " ") ??
            [...rows[index].querySelectorAll("*")].some((part) => part.textContent === name)
        )
      );
    },
    { period, names: selected.slice(0, pageSize).map(planName), total: selected.length }
  );
  await painted(page);
};
/**
 * Verify every remaining page of a full 100-row result after freezing the first usable page timing.
 * @param {Page} page Mounted Recurring application.
 * @param {string} period Calendar month rendered in this occurrence group.
 */
const remainingPages = async (page, period) => {
  const group = page.locator('[data-recurring-slot="occurrence-group"]').filter({
    has: page.locator('tr[aria-label*=" ' + period + '-01 ·"]'),
  });
  const next = group.getByRole("button", { name: /^Página siguiente de/ });
  /** @param {number} start First fixture ordinal on this next product page. */
  const advance = async (start) => {
    await next.click();
    await usable(page, period, allPlans.slice(start, start + pageSize));
    assert.ok(
      await group
        .getByText(start + 1 + "–" + (start + pageSize) + " de " + planCount, { exact: true })
        .isVisible()
    );
    if (start + pageSize < planCount) await advance(start + pageSize);
  };
  await advance(pageSize);
  assert.ok(await next.isDisabled());
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
 * @param {string} journey Controlled workload name.
 * @param {import("@playwright/test").Response} reply Canonical API response.
 */
export const responseEvidence = async (input, journey, reply) => {
  const body = await reply.body();
  const sizes = await reply.request().sizes();
  const headers = await reply.allHeaders();
  const http = {
    status: reply.status(),
    bytes: body.length,
    digest: createHash("sha256").update(body).digest("hex"),
    wireBodyBytes: sizes.responseBodySize,
    wireHeaderBytes: sizes.responseHeadersSize,
    encoding: headers["content-encoding"] ?? "identity",
    httpMs: reply.request().timing().responseEnd,
  };
  input.event({ type: "response", journey, http });
  if (reply.status() !== okStatus) {
    process.stderr.write("REFERENCE_HTTP GET " + reply.status() + "\n");
  }
  assert.equal(reply.status(), okStatus);
  assert.ok(http.wireBodyBytes > 0 && http.httpMs > 0);
  return http;
};
/**
 * @param {Workspace} input Installed origins and evidence sink.
 * @param {{journey:string,query:Record<string,string>, action:()=>Promise<void>, ready:()=>Promise<void>,selected:number[],prior:string,fullSize?:boolean}} cell Predeclared visible interaction.
 */
const measure = async (input, cell) => {
  const response = responseFor(input, route, cell.query);
  input.event({ type: "offered", journey: cell.journey });
  const start = performance.now();
  await cell.action();
  const reply = await response;
  const wire = cell.fullSize ? responseEvidence(input, cell.journey, reply) : undefined;
  if (!reply.ok()) await wire;
  const [milliseconds, observed] = await Promise.all([
    cell.ready().then(() => performance.now() - start),
    wire,
  ]);
  const { value, http: consumedHttp } = await consumed(reply);
  const http = observed ?? consumedHttp;
  verify(value, cell);
  const result = { milliseconds, http };
  input.event({ type: "completed", journey: cell.journey, ...result });
  return { result, reply };
};
/**
 * @param {Workspace} input Installed origins and evidence sink.
 * @param {boolean} [fullSize] Use the unedited 100-plan fixture.
 * @param {import("@playwright/test").Response} authority Actual bound request from this same mounted session.
 */
const fullHistory = async (input, authority, fullSize = false) => {
  const { page, api, event } = input;
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
  const reply = await response;
  const observed = fullSize ? await responseEvidence(input, journey, reply) : undefined;
  const { value, http: consumedHttp } = await consumed(reply);
  const http = observed ?? consumedHttp;
  verify(value, { selected: fullSize ? allPlans : [0, 1], prior: "2026-10", full: true, fullSize });
  assert.ok(http.httpMs > 0);
  const result = { milliseconds: http.httpMs, http };
  event({ type: "completed", journey, ...result });
  return result;
};
const fixtureDocument = Schema.Struct({
  revision: Schema.Int,
  plans: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      revisions: Schema.Array(Schema.Struct({ from: Schema.String, plan })),
    })
  ),
});
const originalDocument = Schema.decodeUnknownSync(
  Schema.Struct({ data: Schema.Struct({ document: fixtureDocument }) })
);
const editResult = Schema.decodeUnknownSync(Schema.Struct({ data: fixtureDocument }));
/**
 * @param {import("@playwright/test").APIRequestContext} request Disposable authenticated context.
 * @param {{api:string,headers:Record<string,string>}} installation Bound loopback reference.
 */
export const prepareReferenceRecurring = async (request, { api, headers }) => {
  assert.equal(new URL(api).hostname, "127.0.0.1");
  const read = await request.get(api + route + "?month=" + month, { headers });
  const original = originalDocument(await read.json()).data.document;
  assert.deepEqual(
    original.plans.map((entry) => entry.revisions.map(({ from }) => from)),
    [dateHistory.slice(0, 2), dateHistory.slice(0, 2)]
  );
  const reply = await request.post(api + route + "/edits", {
    headers,
    data: {
      expectedRevision: original.revision,
      edit: {
        kind: "edit",
        scope: "forward",
        planId: ids[changed],
        date: dateHistory[2],
        plan: {
          ...fixturePlan(changed, dateHistory[2]),
          amountMode: "fixed",
          timeZone: "America/Bogota",
        },
      },
    },
  });
  const ok = 200;
  if (reply.status() !== ok) process.stderr.write("REFERENCE_HTTP " + reply.status() + "\n");
  assert.equal(reply.status(), ok);
  const committed = editResult(await reply.json()).data;
  assert.equal(committed.revision, original.revision + 1);
  assert.deepEqual(
    committed.plans[changed].revisions.map(({ from }) => from),
    dateHistory
  );
};
/** @param {Page} page Mounted Recurring search with no matching plans. */
const usableEmptyResult = async (page) => {
  const empty = page.locator('[data-recurring-slot="empty"]');
  await empty.getByRole("heading", { name: "Sin resultados para estos filtros" }).waitFor();
  await empty.getByRole("button", { name: "Limpiar filtros", disabled: false }).waitFor();
  await painted(page);
};
/** @param {Workspace} input Installed origins and evidence sink. @param {number[]} selected Expected plan ordinals. @param {boolean} fullSize Unedited extreme fixture. */
const prime = async (input, selected, fullSize) => {
  const { page, browser } = input;
  const priming = responseFor(input, route, { month: "2026-10", view: "compact" });
  await page.goto(browser + "/app/recurring?month=2026-10", { waitUntil: "commit" });
  const first = await priming;
  if (fullSize) await responseEvidence(input, "recurring.priming", first);
  const primed = encoded((await consumed(first)).value).data;
  assert.deepEqual(primed.occurrences, expected("2026-10", selected, fullSize));
  await usable(page, "2026-10", selected);
};
/** @param {Workspace} input Mounted Recurring page. @param {boolean} fullSize Unedited extreme fixture. */
const filters = async (input, fullSize) => {
  const { page } = input;
  const filtered = fullSize ? selectedFullPlan : changed;
  await page.getByRole("button", { name: "Filtros", exact: true }).click();
  await page
    .getByRole("textbox", { name: "Buscar recurrentes", exact: true })
    .fill(planName(filtered));
  const selective = await measure(input, {
    journey: "recurring.selective.browser",
    query: { ...compact, previousMonth: "2026-09", search: planName(filtered) },
    selected: [filtered],
    fullSize,
    prior: "2026-09",
    action: () => page.getByRole("button", { name: "Aplicar filtros", exact: true }).click(),
    ready: () => usable(page, month, [filtered]),
  });
  const absent = "Sin coincidencia sintética";
  await page.getByRole("textbox", { name: "Buscar recurrentes", exact: true }).fill(absent);
  const noMatch = await measure(input, {
    journey: "recurring.no-match.browser",
    query: { ...compact, previousMonth: "2026-09", search: absent },
    selected: [],
    fullSize,
    prior: "2026-09",
    action: () => page.getByRole("button", { name: "Aplicar filtros", exact: true }).click(),
    ready: () => usableEmptyResult(page),
  });
  return {
    "recurring.selective.browser": selective.result,
    "recurring.no-match.browser": noMatch.result,
  };
};
/** @param {Workspace} input Installed origins and evidence sink. */
export const freshRecurring = async (input, fullSize = false) => {
  const selected = fullSize ? allPlans : [0, 1];
  const { page } = input;
  await prime(input, selected, fullSize);
  const monthly = await measure(input, {
    journey: "recurring.month.browser",
    query: compact,
    selected,
    fullSize,
    prior: "2026-10",
    action: () => page.getByRole("button", { name: "Mes siguiente", exact: true }).click(),
    ready: () => usable(page, month, selected),
  });
  if (fullSize) await remainingPages(page, month);
  const history = fullSize ? undefined : await fullHistory(input, monthly.reply);
  await earlierPanel(page);
  const prior = await measure(input, {
    journey: "recurring.previous.browser",
    query: { ...compact, previousMonth: "2026-09" },
    selected,
    fullSize,
    prior: "2026-09",
    action: () =>
      page.getByRole("button", { name: "Consultar meses anteriores", exact: true }).click(),
    ready: async () => {
      await earlierPanel(page);
      await usable(page, "2026-09", selected);
    },
  });
  if (fullSize) await remainingPages(page, "2026-09");
  const filtered = await filters(input, fullSize);
  return {
    "recurring.month.browser": monthly.result,
    "recurring.previous.browser": prior.result,
    ...filtered,
    "recurring.full.http": history ?? (await fullHistory(input, monthly.reply, fullSize)),
  };
};
