import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { Schema } from "effect";
import { DashboardDocument } from "../../../apps/server/src/core/dashboard/contract";
import { DashboardView } from "../../../apps/server/src/shell/dashboard/contract";
import { trackBrowserClick } from "./browser-phases.mjs";
import { consumed, painted, responseFor } from "./fresh-workspaces.mjs";

/** @typedef {import("./fresh-workspaces.mjs").Workspace} Workspace */
const shape = ["spending-chart", "budget-bar", "transaction-list", "custom-metric"];
const idWidth = 12,
  success = 200;
const fixedWidget = (/** @type {number} */ position) =>
  "88000000-0000-4000-8000-" + String(position).padStart(idWidth, "0");
const extra = Schema.Record(Schema.String, Schema.Unknown);
const nodeShape = Schema.decodeUnknownSync(
  Schema.Union([
    Schema.Struct({ kind: Schema.Literal("leaf"), widget: Schema.Unknown }),
    Schema.Struct({
      kind: Schema.Literal("split"),
      children: Schema.Array(Schema.Struct({ node: Schema.Unknown })),
    }),
  ])
);
/** @param {unknown} root Validated Dashboard layout. @returns {unknown[]} Ordered wire-format leaves. */
const leaves = (root) => {
  const node = nodeShape(root);
  return node.kind === "leaf"
    ? [node.widget]
    : node.children.flatMap((child) => leaves(child.node));
};
const widget = Schema.StructWithRest(Schema.Struct({ id: Schema.String, type: Schema.String }), [
  extra,
]);
const widgetConfig = Schema.decodeUnknownSync(widget);
const documentReply = Schema.decodeUnknownSync(Schema.Struct({ data: DashboardDocument }));
const documentLayout = Schema.decodeUnknownSync(
  Schema.Struct({ data: Schema.Struct({ layout: Schema.Unknown }) })
);

/**
 * Assign matching WidgetIds through the normal synthetic WebSession on each disposable reference.
 * The protected hosted reader consumes a separately prepared fixture and never calls this helper.
 * @param {import("@playwright/test").APIRequestContext} request Authenticated disposable context.
 * @param {{api:string,headers:Record<string,string>}} installation Bound disposable reference.
 */
export const prepareReferenceDashboard = async (request, { api, headers }) => {
  assert.equal(new URL(api).hostname, "127.0.0.1");
  const initial = await request.post(api + "/dashboard/initialize", { headers });
  assert.equal(initial.status(), success);
  const initialValue = Schema.decodeUnknownSync(Schema.Unknown)(await initial.json());
  documentReply(initialValue);
  const original = leaves(documentLayout(initialValue).data.layout).map(widgetConfig);
  assert.deepEqual(
    original.map((widget) => widget.type),
    shape
  );
  const edits = original.flatMap((previous, index) => [
    {
      op: "add-widget",
      widget: { ...previous, id: fixedWidget(index) },
      at: { besideWidget: previous.id, axis: "row", side: "after" },
    },
    { op: "remove-widget", widgetId: previous.id },
  ]);
  // Each insertion and subsequent removal transform the previously committed layout.
  await edits.reduce(async (applied, data) => {
    await applied;
    const reply = await request.post(api + "/dashboard/edits", { headers, data });
    if (reply.status() !== success) process.stderr.write("REFERENCE_HTTP " + reply.status() + "\n");
    assert.equal(reply.status(), success, "Dashboard fixture edit failed");
    documentReply(await reply.json());
  }, Promise.resolve());
};

const completeView = Schema.decodeUnknownSync(Schema.Struct({ data: DashboardView }));
const rawContext = Schema.StructWithRest(Schema.Struct({ calculatedAt: Schema.String }), [extra]);
const rawData = Schema.StructWithRest(Schema.Struct({ context: rawContext }), [extra]);
const rawResponse = Schema.decodeUnknownSync(
  Schema.StructWithRest(Schema.Struct({ data: rawData }), [extra])
);
/** @param {unknown} value Complete actual Dashboard response, including operation metadata. */
const comparableDashboard = (value) => {
  const raw = rawResponse(value);
  const normalized = {
    ...raw,
    data: { ...raw.data, context: { ...raw.data.context, calculatedAt: "observation-time" } },
  };
  return createHash("sha256").update(JSON.stringify(normalized)).digest("hex");
};
const effectiveCount = 7;
const ordinals = Array.from({ length: effectiveCount }, (_, index) =>
  index === 0 ? 0 : index + 1
);
const expectedRows = ordinals.map((ordinal) => ({
  id: "81000000-0000-4000-8000-" + String(ordinal).padStart(idWidth, "0"),
  name: ordinal === 2 ? "Referencia corregida" : "Evaluación " + ordinal,
  currency: ordinal % 2 === 0 ? "COP" : "USD",
}));
const projected = Schema.decodeUnknownSync(Schema.Struct({ widget, result: Schema.Unknown }));
const recentRows = Schema.decodeUnknownSync(
  Schema.Struct({
    transactions: Schema.Array(
      Schema.Struct({
        id: Schema.String,
        direction: Schema.String,
        counterparty: Schema.String,
        money: Schema.Struct({ amount: Schema.String, currency: Schema.String }),
      })
    ),
  })
);
const money = Schema.Struct({ currency: Schema.String, amount: Schema.String });
const groups = Schema.Array(
  Schema.Struct({ currency: Schema.String, inflow: money, outflow: money })
);
const metric = Schema.decodeUnknownSync(Schema.Struct({ moneyGroups: groups }));
const chart = Schema.decodeUnknownSync(
  Schema.Struct({
    buckets: Schema.Array(
      Schema.Struct({
        key: Schema.Struct({ category: Schema.Struct({ id: Schema.String }) }),
        moneyGroups: groups,
      })
    ),
  })
);
const budget = Schema.decodeUnknownSync(
  Schema.Struct({ availability: Schema.Literal("available"), cap: money, spent: money })
);
/** @param {ReturnType<typeof projected>[]} widgets Projected leaves in calibrated layout order. */
const verifySpending = (widgets) => {
  const total = metric(widgets[3].result).moneyGroups;
  assert.deepEqual(
    total.map(({ currency, inflow, outflow }) => [currency, inflow.amount, outflow.amount]),
    [
      ["COP", "0", "4000"],
      ["USD", "0", "3000"],
    ]
  );
  assert.deepEqual(budget(widgets[1].result), {
    availability: "available",
    cap: { currency: "COP", amount: "100000" },
    spent: { currency: "COP", amount: "2000" },
  });
  const buckets = chart(widgets[0].result).buckets;
  const figures = buckets.flatMap(({ key, moneyGroups }) =>
    moneyGroups.map(({ currency, inflow, outflow }) =>
      [key.category.id, currency, inflow.amount, outflow.amount].join("/")
    )
  );
  const prefix = "10000000-0000-4000-8000-00000000000";
  assert.deepEqual(
    figures.sort(),
    [
      "1/COP/0/2000",
      "1/USD/0/1000",
      "4/COP/0/1000",
      "6/COP/0/1000",
      "7/USD/0/1000",
      "9/USD/0/1000",
    ].map((entry) => prefix + entry)
  );
};
/** @param {unknown} value Complete Dashboard projection. */
const verifiedWidgets = (value) => {
  completeView(value);
  const raw = rawResponse(value).data;
  assert.equal(raw.title, "Tablero");
  assert.equal(raw.context.timeZone, "America/Bogota");
  const widgets = leaves(raw.layout).map(projected);
  assert.deepEqual(
    widgets.map((item) => item.widget.type),
    shape
  );
  assert.deepEqual(
    widgets.map((item) => item.widget.id),
    shape.map((_, index) => fixedWidget(index))
  );
  verifySpending(widgets);
  const recent = widgets.find((item) => item.widget.type === "transaction-list");
  assert.ok(recent);
  const { transactions } = recentRows(recent.result);
  assert.deepEqual(
    transactions,
    expectedRows.map((row) => ({
      id: row.id,
      counterparty: row.name,
      direction: "outflow",
      money: { amount: "1000", currency: row.currency },
    }))
  );
};
/** @param {import("@playwright/test").Page} page Mounted Transactions page. */
const watchDashboard = (page) =>
  page.evaluateHandle((rows) => {
    let readyAt;
    let frame = 0;
    const milestones = new Map();
    const mark = (name) => {
      if (!milestones.has(name)) milestones.set(name, performance.now());
    };
    const visible = (element) => Boolean(element?.getClientRects().length);
    const query = (selector) => document.querySelector(selector);
    const ready = () => {
      const chart = '[data-widget-type="spending-chart"]';
      const charts = visible(query(chart + ' [aria-label="Serie COP"]')) &&
        visible(query(chart + ' [aria-label="Serie USD"]'));
      if (charts) mark("charts-visible");
      const budget = query('[data-widget-type="budget-bar"] .dashboard-budget-values');
      const metric = query('[data-widget-type="custom-metric"]');
      const transactions = rows.every(({ id, name }) =>
        [...document.querySelectorAll('a[href*="' + id + '"]')].some(
          (link) => visible(link) && link.textContent.includes(name)
        )
      );
      if (transactions) mark("transactions-visible");
      return (
        charts &&
        visible(budget) &&
        /2[.]?000/u.test(budget?.textContent ?? "") &&
        visible(metric) &&
        /4[.]?000/u.test(metric?.textContent ?? "") &&
        /3[.]?000/u.test(metric?.textContent ?? "") &&
        transactions
      );
    };
    const observer = new MutationObserver(() => {
      for (const pending of document.querySelectorAll('output[aria-label="Cargando tablero"]')) {
        mark(pending.parentElement?.classList.contains("contents") ? "query-pending" : "route-fallback");
      }
      if (query('output[aria-label="Cargando gráfico"]')) mark("chart-fallback");
      if (frame !== 0) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        if (ready()) {
          readyAt = performance.now();
          observer.disconnect();
        }
      });
    });
    observer.observe(document.body, { subtree: true, childList: true, characterData: true });
    return {
      stop: () => {
        observer.disconnect();
        if (frame !== 0) cancelAnimationFrame(frame);
        return { readyAt, milestones: [...milestones] };
      },
    };
  }, expectedRows);

/** @param {Workspace} input Installed origins, mounted browser and evidence sink. */
export const freshDashboard = async (input) => {
  const { page, browser, event } = input;
  await page.goto(browser + "/app/transactions?month=2026-11", { waitUntil: "commit" });
  await page
    .locator("#transaction-81000000-0000-4000-8000-000000000002:enabled")
    .filter({ hasText: "Referencia corregida" })
    .waitFor();
  const response = responseFor(input, "/dashboard/view", {});
  const journey = "dashboard.fresh.browser";
  const control = page.locator('a[href="/app/dashboard"]:visible').first();
  const recordPhases = input.recordPhases ? await trackBrowserClick(control) : undefined;
  const dashboardReady = input.recordPhases ? await watchDashboard(page) : undefined;
  event({ type: "offered", journey });
  const start = performance.now();
  await control.click();
  const reply = await response;
  await page.waitForFunction(
    (rows) =>
      rows.every(({ id, name }) => {
        const anchors = document.querySelectorAll('a[href*="' + id + '"]');
        return [...anchors].some(
          (link) => link.getClientRects().length > 0 && link.textContent.includes(name)
        );
      }),
    expectedRows
  );
  const chartCard = page.locator('[data-widget-type="spending-chart"]');
  await Promise.all([
    chartCard.getByRole("region", { name: "Serie COP", exact: true }).waitFor(),
    chartCard.getByRole("region", { name: "Serie USD", exact: true }).waitFor(),
    page
      .locator('[data-widget-type="budget-bar"] .dashboard-budget-values')
      .filter({ hasText: /2[.]?000/u })
      .waitFor(),
    page
      .locator('[data-widget-type="custom-metric"]')
      .filter({ hasText: /4[.]?000/u })
      .filter({ hasText: /3[.]?000/u })
      .waitFor(),
  ]);
  const paintedAt = await painted(page);
  const milliseconds = performance.now() - start;
  const { value, http } = await consumed(reply);
  verifiedWidgets(value);
  const result = {
    milliseconds,
    http: {
      ...http,
      comparableDigest: comparableDashboard(value),
      ignoredField: "data.context.calculatedAt",
    },
  };
  event({ type: "completed", journey, ...result });
  if (recordPhases && dashboardReady) {
    const { readyAt, milestones } = await dashboardReady.evaluate(({ stop }) => stop());
    await dashboardReady.dispose();
    const phases = await recordPhases(reply, paintedAt, readyAt);
    event({
      type: "phases",
      journey,
      ...phases,
      milestonesBeforePaintMs: Object.fromEntries(
        milestones.map(([name, time]) => [name, paintedAt - time])
      ),
    });
  }
  return result;
};
