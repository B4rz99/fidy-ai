// Bundled only in the disposable comparator. The original frozen application owns all SQL.
import { AsyncLocalStorage } from "node:async_hooks";

/** @import { Cost, CoreEnvironment, Database, Frame, MeterConfig, PinnedCore, PinnedCoordinator, Statement, StatementReply } from "./contracts.d.mts" */

const hexBase = 16;
/** @type {AsyncLocalStorage<Frame>} */
const active = new AsyncLocalStorage();
/** @type {WeakMap<Statement, {sql: string, statement: Statement}>} */
const nativeStatements = new WeakMap();
/** @type {ReadonlyArray<keyof Cost>} */
const fields = ["rowsRead", "rowsWritten"];
const receipt = "x-fidy-comparison-cost";

const context = () => {
  const frame = active.getStore();
  if (!frame || frame.fault || frame.closed) throw new Error("Unadmitted D1 work");
  return frame;
};
/** @returns {never} */
const stop = () => {
  const frame = active.getStore();
  if (frame) frame.fault = true;
  throw new Error("Unaccounted comparator work");
};
/** @param {unknown} value Native row counter. */
const count = (value) => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const zero = () => ({ rowsRead: 0, rowsWritten: 0 });
/** @param {string[]} sql Native statement group and operation. */
const digest = async (sql) => {
  const bytes = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(JSON.stringify(sql))
  );
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(hexBase).padStart(2, "0")).join(
    ""
  );
};

/**
 * @param {Frame} frame Active accounting.
 * @param {string} key Statement digest.
 */
const reserve = (frame, key) => {
  if (frame.training) return null;
  const cap = frame.plan.statements[key];
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
/** @param {Partial<StatementReply> | null | undefined} reply Native result. */
const confirmedRows = (reply) =>
  reply?.success === true && count(reply.meta?.rows_read) && count(reply.meta?.rows_written);
/**
 * @param {StatementReply[]} replies Native replies.
 * @param {number} length Expected statements.
 */
const nativeRows = (replies, length) => {
  if (!Array.isArray(replies) || !length || replies.length !== length) stop();
  const actual = zero();
  for (const reply of replies) {
    const meta = reply.meta;
    if (!confirmedRows(reply)) stop();
    actual.rowsRead += meta.rows_read;
    actual.rowsWritten += meta.rows_written;
  }
  return actual;
};
/**
 * @param {string[]} shape Operation and SQL.
 * @param {() => Promise<StatementReply[]>} execute Native operation.
 */
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
/**
 * @param {Statement} statement Native prepared query.
 * @param {string} sql Original SQL.
 * @returns {Statement}
 */
const prepared = (statement, sql) => {
  /** @param {"all" | "run"} op Native terminal operation. */
  const one = async (op) => (await nativeCall([op, sql], async () => [await statement[op]()]))[0];
  /** @type {Statement} */
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
/**
 * @param {Database} database Native binding or session.
 * @returns {Database}
 */
const binding = (database) => {
  return {
    prepare: (sql) => prepared(database.prepare(sql), sql),
    withSession: (...args) => binding(database.withSession(...args)),
    getBookmark: () => database.getBookmark(),
    batch: (statements) => {
      const batch = statements.map((view) => nativeStatements.get(view) ?? stop());
      return nativeCall(["batch", ...batch.map((view) => view.sql)], () =>
        database.batch(batch.map((view) => view.statement))
      );
    },
  };
};

/** @param {unknown} value Private registry response. */
const zeroReceipt = (value) =>
  typeof value === "object" &&
  value !== null &&
  "rowsRead" in value &&
  value.rowsRead === 0 &&
  "rowsWritten" in value &&
  value.rowsWritten === 0;
// The pinned Core consults the private registry for erasure metadata during Login.
// Only that exact child request is permitted. Its mounted owner has a zero-D1 envelope.
/**
 * @param {CoreEnvironment} env Bound disposable Core resources.
 * @param {MeterConfig} config Protected package and fixture scope.
 * @returns {CoreEnvironment}
 */
const guardedEnvironment = (env, config) => {
  const isolated = { ...env, DB: binding(env.DB) };
  /** @type {ReadonlyArray<"USER_TRANSACTION_COORDINATOR" | "ERASURE_REGISTRY_COORDINATOR">} */
  const namespaces = ["USER_TRANSACTION_COORDINATOR", "ERASURE_REGISTRY_COORDINATOR"];
  for (const name of namespaces) {
    const namespace = env[name];
    isolated[name] = {
      idFromName: (...args) => namespace.idFromName(...args),
      getByName: (owner, options) => ({
        fetch: async (input, init) => {
          const request = new Request(input, init);
          const frame = context();
          const child = request.method + " " + new URL(request.url).pathname;
          const expectedChild = frame.route.startsWith("PUT /transactions/")
            ? "POST /call"
            : frame.route === "POST /operations/atomic-batch"
              ? "POST /batch"
              : null;
          if (
            config.mutationSubject &&
            name === "USER_TRANSACTION_COORDINATOR" &&
            owner === config.mutationSubject &&
            new URL(request.url).origin === "https://coordinator.internal" &&
            child === expectedChild
          ) {
            const key = "coordinator:" + child;
            const cap = reserve(frame, key);
            if (cap && fields.some((field) => cap[field] !== config.limits[child]?.maximum[field]))
              stop();
            frame.inflight++;
            try {
              const response = await namespace.getByName(owner, options).fetch(request);
              const cost = JSON.parse(response.headers.get(receipt) ?? "null");
              if (
                !cost ||
                !fields.every((field) => count(cost[field]) && (!cap || cost[field] <= cap[field]))
              )
                stop();
              if (frame.training && (cost.route !== child || !Array.isArray(cost.calls))) stop();
              frame.calls.push({
                key,
                child,
                rowsRead: cost.rowsRead,
                rowsWritten: cost.rowsWritten,
                ...(frame.training ? { calls: cost.calls } : {}),
              });
              for (const field of fields) frame.used[field] += cost[field];
              return response;
            } catch {
              return stop();
            } finally {
              frame.inflight--;
              if (cap) for (const field of fields) frame.pending[field] -= cap[field];
            }
          }
          if (
            owner !== "erasure-registry-v1" ||
            request.url !== "https://erasure-registry.invalid/metadata"
          ) {
            stop();
          }
          frame.inflight++;
          try {
            const response = await namespace.getByName(owner, options).fetch(request);
            /** @type {unknown} */
            const cost = JSON.parse(response.headers.get(receipt) ?? "null");
            if (!zeroReceipt(cost)) stop();
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
/**
 * @param {MeterConfig} config Calibration state and per-route bounds.
 * @param {Request} request Private request.
 * @param {() => Promise<Response>} run Original frozen handler.
 */
const measured = async ({ limits, training }, request, run) => {
  const url = new URL(request.url);
  const route = request.method + " " + url.pathname + url.search;
  const zeroOnly = request.url === "https://erasure-registry.invalid/metadata";
  if (!zeroOnly && !training && !Object.hasOwn(limits, route)) {
    return new Response(null, { status: 403 });
  }
  /** @type {Frame} */
  const frame = {
    zeroOnly,
    route,
    training,
    closed: false,
    inflight: 0,
    plan: limits[route] ?? { maximum: zero(), statements: {} },
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
/**
 * @param {PinnedCore} core Frozen application Core.
 * @param {PinnedCoordinator} Coordinator Frozen application coordinator.
 * @param {MeterConfig} config Calibrated bounds for this bundle.
 */
export const meteredCore = (core, Coordinator, config) => {
  class UserTransactionCoordinator {
    /**
     * @param {unknown} state Native object state.
     * @param {CoreEnvironment} env Disposable bindings.
     */
    constructor(state, env) {
      this.owner = new Coordinator(state, guardedEnvironment(env, config));
    }
    /** @param {Request} request Original request. */
    fetch(request) {
      return measured(config, request, () => this.owner.fetch(request));
    }
  }
  const worker = {
    /**
     * @param {Request} request Original request.
     * @param {CoreEnvironment} env Disposable bindings.
     * @param {unknown} execution Native execution context.
     */
    fetch(request, env, execution) {
      return measured(config, request, () =>
        core.fetch(request, guardedEnvironment(env, config), execution)
      );
    },
  };
  return { worker, UserTransactionCoordinator };
};
