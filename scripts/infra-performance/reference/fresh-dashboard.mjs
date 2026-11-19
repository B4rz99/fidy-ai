import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { Schema } from "effect";
import { DashboardDocument, Widget } from "../../../apps/server/src/core/dashboard/contract";
import { DashboardView } from "../../../apps/server/src/shell/dashboard/contract";
import { consumed, painted, responseFor } from "./fresh-workspaces.mjs";

/** @typedef {import("./fresh-workspaces.mjs").Workspace} Workspace */
const shape = ["spending-chart", "budget-bar", "transaction-list", "custom-metric"];
const idWidth = 12,
  success = 200;
const fixedWidget = (/** @type {number} */ position) =>
  "88000000-0000-4000-8000-" + String(position).padStart(idWidth, "0");
/**
 * @template Leaf
 * @param {import("../../../apps/server/src/core/dashboard/contract").LayoutNodeFor<Leaf>} node Document or projected layout node.
 * @returns {Leaf[]} Ordered leaves in the recorded layout.
 */
const leaves = (node) =>
  node.kind === "leaf" ? [node.widget] : node.children.flatMap((child) => leaves(child.node));
const documentReply = Schema.decodeUnknownSync(Schema.Struct({ data: DashboardDocument }));
const bindingReply = Schema.decodeUnknownSync(Schema.Struct({ binding: Schema.NonEmptyString }));
const encodeWidget = Schema.encodeSync(Widget);

/**
 * Assign matching WidgetIds through the normal synthetic WebSession on each disposable reference.
 * The protected hosted reader consumes a separately prepared fixture and never calls this helper.
 * @param {import("@playwright/test").APIRequestContext} request Authenticated disposable context.
 * @param {{api:string,browser:string}} origins Loopback reference installation.
 */
export const prepareReferenceDashboard = async (request, { api, browser }) => {
  assert.equal(new URL(api).hostname, "127.0.0.1");
  assert.equal(new URL(browser).hostname, "127.0.0.1");
  const binding = await request.get(api + "/web/session/binding", { headers: { origin: browser } });
  assert.equal(binding.status(), success);
  const headers = {
    origin: browser,
    "fidy-session-binding": bindingReply(await binding.json()).binding,
  };
  const initial = await request.post(api + "/dashboard/initialize", { headers });
  assert.equal(initial.status(), success);
  const original = leaves(documentReply(await initial.json()).data.layout);
  assert.deepEqual(
    original.map((widget) => widget.type),
    shape
  );
  for (const [index, widget] of original.entries()) {
    // Placement followed by removal preserves the enclosing split in its previous position.
    const replacement = { ...encodeWidget(widget), id: fixedWidget(index) };
    const edits = [
      {
        op: "add-widget",
        widget: replacement,
        at: { besideWidget: widget.id, axis: "row", side: "after" },
      },
      { op: "remove-widget", widgetId: widget.id },
    ];
    for (const data of edits) {
      const reply = await request.post(api + "/dashboard/edits", { headers, data });
      assert.equal(reply.status(), success, "Dashboard fixture edit failed");
      documentReply(await reply.json());
    }
  }
};

const completeView = Schema.decodeUnknownSync(Schema.Struct({ data: DashboardView }));
const extra = Schema.Record(Schema.String, Schema.Unknown);
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
const ordinals = [0, 2, 3, 4, 5, 6, 7];
const expectedRows = ordinals.map((ordinal) => ({
  id: "81000000-0000-4000-8000-" + String(ordinal).padStart(idWidth, "0"),
  name: ordinal === 2 ? "Referencia corregida" : "Evaluación " + ordinal,
  currency: ordinal % 2 === 0 ? "COP" : "USD",
}));
/** @param {unknown} value Complete Dashboard projection. */
const verifiedWidgets = (value) => {
  const data = completeView(value).data,
    widgets = leaves(data.layout);
  assert.equal(data.title, "Tablero");
  assert.equal(data.context.timeZone, "America/Bogota");
  assert.deepEqual(
    widgets.map((item) => item.widget.type),
    shape
  );
  assert.deepEqual(
    widgets.map((item) => item.widget.id),
    shape.map((_, index) => fixedWidget(index))
  );
  const recent = widgets.find((item) => "transactions" in item.result);
  assert.ok(recent && "transactions" in recent.result);
  assert.deepEqual(
    recent.result.transactions.map((row) => row.id),
    expectedRows.map((row) => row.id)
  );
  const wire = Schema.encodeSync(DashboardView)(data);
  const list = leaves(wire.layout).find((item) => "transactions" in item.result);
  assert.ok(list && "transactions" in list.result);
  for (const [index, row] of list.result.transactions.entries()) {
    assert.equal(row.counterparty, expectedRows[index].name);
    assert.deepEqual(row.money, { amount: "1000", currency: expectedRows[index].currency });
    assert.equal(row.direction, "outflow");
  }
};
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
  event({ type: "offered", journey });
  const start = performance.now();
  await page.locator('a[href="/app/dashboard"]:visible').first().click();
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
  await painted(page);
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
  return result;
};
