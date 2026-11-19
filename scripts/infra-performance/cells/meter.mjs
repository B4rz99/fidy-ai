// Bundled only in the disposable comparator. The original frozen application owns all SQL.
import { AsyncLocalStorage } from "node:async_hooks";
import core, { UserTransactionCoordinator as PinnedCoordinator } from "./core-worker.mjs";
import limits from "./limits.json";

const hexBase = 16;
const active = new AsyncLocalStorage();
const nativeStatements = new WeakMap();
const fields = ["rowsRead", "rowsWritten"];
const training = limits === null;
const receipt = "x-fidy-comparison-cost";

const context = () => {
  const frame = active.getStore();
  if (!frame || frame.fault || frame.closed) throw new Error("Unadmitted D1 work");
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
  const bytes = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(JSON.stringify(sql))
  );
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(hexBase).padStart(2, "0")).join(
    ""
  );
};

const reserve = (frame, key) => {
  if (training) return null;
  const cap = frame.plan?.statements[key];
  if (
    !cap ||
    fields.some(
      (field) =>
        !count(cap[field]) ||
        frame.used[field] + frame.pending[field] + cap[field] > frame.plan.maximum[field]
    )
  ) {
    stop();
  }
  for (const field of fields) frame.pending[field] += cap[field];
  return cap;
};
const confirmedRows = (reply) =>
  reply?.success === true && count(reply.meta?.rows_read) && count(reply.meta?.rows_written);
const nativeRows = (replies, length) => {
  if (!Array.isArray(replies) || !length || replies.length !== length) stop();
  const actual = zero();
  for (const reply of replies) {
    const meta = reply?.meta;
    if (!confirmedRows(reply)) stop();
    actual.rowsRead += meta.rows_read;
    actual.rowsWritten += meta.rows_written;
  }
  return actual;
};
const nativeCall = async (shape, execute) => {
  const frame = context();
  if (frame.zeroOnly) stop();
  const key = await digest(shape);
  const cap = reserve(context(), key);
  frame.inflight++;
  try {
    const replies = await execute();
    const actual = nativeRows(replies, shape.length - 1);
    for (const field of fields) frame.used[field] += actual[field];
    if (cap && fields.some((field) => actual[field] > cap[field])) stop();
    frame.calls.push({ key, ...actual });
    return replies;
  } catch {
    return stop();
  } finally {
    frame.inflight--;
    if (cap) for (const field of fields) frame.pending[field] -= cap[field];
  }
};
const prepared = (statement, sql) => {
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
};
const binding = (database) => {
  return {
    prepare: (sql) => prepared(database.prepare(sql), sql),
    withSession: (...args) => binding(database.withSession(...args)),
    getBookmark: () => database.getBookmark(),
    batch: (statements) => {
      const batch = statements.map((view) => nativeStatements.get(view));
      if (batch.some((view) => !view)) stop();
      return nativeCall(["batch", ...batch.map((view) => view.sql)], () =>
        database.batch(batch.map((view) => view.statement))
      );
    },
  };
};

// The pinned Core consults the private registry for erasure metadata during Login.
// Only that exact child request is permitted. Its mounted owner has a zero-D1 envelope.
const guardedEnvironment = (env) => {
  const isolated = { ...env, DB: binding(env.DB) };
  for (const name of ["USER_TRANSACTION_COORDINATOR", "ERASURE_REGISTRY_COORDINATOR"]) {
    const namespace = env[name];
    if (!namespace) continue;
    isolated[name] = {
      idFromName: (...args) => namespace.idFromName(...args),
      getByName: (owner, options) => ({
        fetch: async (input, init) => {
          const request = new Request(input, init);
          if (
            owner !== "erasure-registry-v1" ||
            request.url !== "https://erasure-registry.invalid/metadata"
          ) {
            stop();
          }
          const frame = context();
          frame.inflight++;
          try {
            const response = await namespace.getByName(owner, options).fetch(request);
            const cost = JSON.parse(response.headers.get(receipt) ?? "null");
            if (cost?.rowsRead !== 0 || cost?.rowsWritten !== 0) stop();
            return response;
          } finally {
            frame.inflight--;
          }
        },
      }),
    };
  }
  return isolated;
};
const measured = async (request, run) => {
  const url = new URL(request.url);
  const route = request.method + " " + url.pathname + url.search;
  const zeroOnly = request.url === "https://erasure-registry.invalid/metadata";
  if (!zeroOnly && !training && !Object.hasOwn(limits, route)) {
    return new Response(null, { status: 403 });
  }
  const frame = {
    zeroOnly,
    closed: false,
    inflight: 0,
    plan: limits?.[route],
    used: zero(),
    pending: zero(),
    calls: [],
    fault: false,
  };
  return active.run(frame, async () => {
    try {
      const response = await run();
      const body = await response.arrayBuffer();
      frame.closed = true;
      if (frame.fault || frame.inflight || fields.some((field) => frame.pending[field] !== 0)) {
        return new Response(null, { status: 503 });
      }
      const headers = new Headers(response.headers);
      headers.set(
        receipt,
        JSON.stringify(training ? { route, ...frame.used, calls: frame.calls } : frame.used)
      );
      return new Response(body.byteLength || response.body !== null ? body : null, {
        headers,
        status: response.status,
      });
    } catch {
      return new Response(null, { status: 503 });
    } finally {
      frame.closed = true;
    }
  });
};
export class UserTransactionCoordinator {
  constructor(state, env) {
    this.owner = new PinnedCoordinator(state, guardedEnvironment(env));
  }
  fetch(request) {
    return measured(request, () => this.owner.fetch(request));
  }
}
export const worker = {
  fetch(request, env, execution) {
    return measured(request, () => core.fetch(request, guardedEnvironment(env), execution));
  },
};
