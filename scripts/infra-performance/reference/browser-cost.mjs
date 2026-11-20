import assert from "node:assert/strict";
import { Schema } from "effect";
import { targetId } from "./fresh-transactions.mjs";

const counters = Schema.decodeUnknownSync(
  Schema.Struct({ rowsRead: Schema.Int, rowsWritten: Schema.Int })
);
const paths = new Set([
  "/web/session/binding",
  "/user",
  "/categories",
  "/transactions",
  "/budget-status",
  "/dashboard/view",
  "/recurring-plans",
  "/ingestion/review-workspace",
  "/ingestion/review-workspace/context",
]);

/**
 * Sample only the isolated native D1 counters. Timing comparisons never install this observer.
 * @param {import("@playwright/test").Page} page Mounted browser.
 * @param {{ api: string, operator: string }} origins Disposable D1 and fixture observation origins.
 * @param {(row: Readonly<Record<string, unknown>>) => void} event Journal for this attempt.
 */
export const observeBrowserD1 = (page, { api, operator }, event) => {
  assert.equal(new URL(api).hostname, "127.0.0.1");
  assert.equal(new URL(operator).hostname, "127.0.0.1");
  /** @type {Set<import("@playwright/test").Request>} */
  const active = new Set();
  /** @type {Array<{method:string,route:string,queryKeys:string[],status:number}>} */
  const replies = [];
  page.on("request", (request) => {
    if (new URL(request.url()).origin === api) active.add(request);
  });
  page.on("response", (reply) => {
    const url = new URL(reply.url());
    if (url.origin !== api) return;
    const route =
      url.pathname === "/transactions/" + targetId ? "/transactions/:target" : url.pathname;
    replies.push({
      method: reply.request().method(),
      route: route === "/transactions/:target" || paths.has(route) ? route : "other",
      queryKeys: [...url.searchParams.keys()].sort(),
      status: reply.status(),
    });
  });
  page.on("requestfinished", (request) => active.delete(request));
  page.on("requestfailed", (request) => active.delete(request));
  return async (/** @type {string} */ stage) => {
    await Promise.all(
      Array.from(active, async (request) => (await request.response())?.finished())
    );
    const response = await page.context().request.get(operator + "/browser-cost");
    assert.ok(response.ok(), "Missing local D1 browser counters");
    event({
      type: "d1-cost",
      stage,
      ...counters(await response.json()),
      requests: replies.splice(0),
    });
  };
};
