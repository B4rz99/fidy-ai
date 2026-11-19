// Bundled only in the disposable comparator. The original frozen application owns all SQL.
import { AsyncLocalStorage } from "node:async_hooks";
import core, { UserTransactionCoordinator as PinnedCoordinator } from "./core-worker.mjs";
import limits from "./limits.json";

const active = new AsyncLocalStorage();
const nativeStatements = new WeakMap();
const fields = ["rowsRead", "rowsWritten"];
const training = limits === null;
const receipt = "x-fidy-comparison-cost";

const context = () => {
  const frame = active.getStore();
  if (!frame || frame.fault) throw new Error("Unadmitted D1 work");
  return frame;
};
const stop = () => {
  const frame = active.getStore();
  if (frame) frame.fault = true;
  throw new Error("Unaccounted comparator work");
};
const count = (value) => Number.isSafeInteger(value) && value >= 0;
const zero = () => ({ rowsRead: 0, rowsWritten: 0 });
const digest = async (sql) => {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(sql)));
  return Array.from(new Uint8Array(bytes), b => b.toString(16).padStart(2, "0")).join("");
};

async function nativeCall(shape, execute) {
  const frame = context();
  const key = await digest(shape);
  const cap = training ? null : frame.plan?.statements[key];
  if (!training && (!cap || fields.some(k => !count(cap[k]) || frame.used[k] + frame.pending[k] + cap[k] > frame.plan.maximum[k]))) stop();
  if (cap) for (const k of fields) frame.pending[k] += cap[k];
  try {
    const replies = await execute();
    if (!Array.isArray(replies) || !replies.length || replies.length !== shape.length - 1) stop();
    const actual = zero();
    for (const reply of replies) {
      if (reply?.success !== true || !count(reply.meta?.rows_read) || !count(reply.meta?.rows_written)) stop();
      actual.rowsRead += reply.meta.rows_read;
      actual.rowsWritten += reply.meta.rows_written;
    }
    for (const k of fields) frame.used[k] += actual[k];
    if (cap && fields.some(k => actual[k] > cap[k])) stop();
    frame.calls.push({ key, ...actual });
    return replies;
  } catch {
    return stop();
  } finally {
    if (cap) for (const k of fields) frame.pending[k] -= cap[k];
  }
}
function prepared(statement, sql) {
  const one = async (op) => (await nativeCall([op, sql], async () => [await statement[op]()]))[0];
  const view = {
    bind: (...parameters) => prepared(statement.bind(...parameters), sql),
    all: () => one("all"),
    run: () => one("run"),
    first: async (column) => {
      const row = (await one("all")).results[0];
      if (!row) return null;
      if (column === undefined) return row;
      if (!(column in row)) throw new Error("D1_COLUMN_NOTFOUND");
      return row[column];
    },
  };
  nativeStatements.set(view, { sql, statement });
  return view;
}
function binding(database) {
  return {
    prepare: sql => prepared(database.prepare(sql), sql),
    withSession: (...args) => binding(database.withSession(...args)),
    getBookmark: () => database.getBookmark(),
    batch: statements => {
      const batch = statements.map(s => nativeStatements.get(s));
      if (batch.some(s => !s)) stop();
      return nativeCall(["batch", ...batch.map(s => s.sql)], () => database.batch(batch.map(s => s.statement)));
    },
  };
}

// A second D1-bearing isolate cannot participate unless its native counters can be reconciled.
// Refuse before such a call; this cell exercises the single registered read owner in the pinned graph.
function guardedEnvironment(env) {
  const isolated = { ...env, DB: binding(env.DB) };
  for (const name of ["USER_TRANSACTION_COORDINATOR", "ERASURE_REGISTRY_COORDINATOR"]) {
    if (env[name]) isolated[name] = { idFromName: (...args) => env[name].idFromName(...args), getByName: stop, get: stop };
  }
  return isolated;
}
async function measured(request, run) {
  const url = new URL(request.url);
  const route = request.method + " " + url.pathname + url.search;
  if (!training && !Object.hasOwn(limits, route)) return new Response(null, { status: 403 });
  const frame = { plan: limits?.[route], used: zero(), pending: zero(), calls: [], fault: false };
  return active.run(frame, async () => {
    try {
      const response = await run();
      const body = await response.arrayBuffer();
      if (frame.fault || fields.some(k => frame.pending[k] !== 0)) return new Response(null, { status: 503 });
      const headers = new Headers(response.headers);
      headers.set(receipt, JSON.stringify(training ? { route, ...frame.used, calls: frame.calls } : frame.used));
      return new Response(body.byteLength || response.body !== null ? body : null, { headers, status: response.status });
    } catch {
      return new Response(null, { status: 503 });
    }
  });
}
export class UserTransactionCoordinator {
  constructor(state, env) {
    this.owner = new PinnedCoordinator(state, guardedEnvironment(env));
  }
  fetch(request) { return measured(request, () => this.owner.fetch(request)); }
}
export default {
  fetch(request, env, execution) { return measured(request, () => core.fetch(request, guardedEnvironment(env), execution)); },
};
