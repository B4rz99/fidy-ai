// Scratch-only read-only instrumentation copied alongside the pinned preview.
import { appendFileSync } from "node:fs";
const paths = new Set([
  "/web/session/binding", "/dashboard/initialize", "/dashboard/edits",
  "/recurring-plans", "/recurring-plans/edits", "/transactions", "/user", "/categories",
  "/ingestion/review-workspace", "/ingestion/review-workspace/context", "/budget-status",
  "/dashboard/view", "/dashboard/catalog", "/web/pairings", "/web/pairings/redeem",
]);
const snapshot = `SELECT COALESCE((SELECT max(0,virtual_at_ms-?2) FROM canonical_request_buckets
  WHERE subject='user:'||?1),0) AS aheadMs,
  (SELECT count(*) FROM canonical_request_leases WHERE user_id=?1 AND expires_at_ms>?2) AS leases`;
const fixture = "24000000-0000-4000-8000-000000000481";
export const recordPressure = async (request, response, from, select) => {
  if (!["GET", "PUT", "POST"].includes(request.method)) return response;
  const url = new URL(request.url);
  let operation = url.pathname;
  if (operation.startsWith("/transactions/")) operation = "/transactions/:id";
  else if (!paths.has(operation)) return response;
  if (operation === "/web/session/binding" && url.searchParams.has("context")) operation += "/context";
  const completed = performance.now();
  const inspect = response.status === 429 || (operation === "/recurring-plans/edits" && request.method === "POST");
  const sample = inspect ? await select(snapshot, fixture, Date.now()) : undefined;
  appendFileSync(process.env.REFERENCE_PRESSURE_FILE, JSON.stringify({
    operation, method: request.method, status: response.status, from, completed,
    ...(sample ? { aheadMs: Number(sample.aheadMs), leases: Number(sample.leases) } : {}),
  }) + "\n");
  return response;
};
