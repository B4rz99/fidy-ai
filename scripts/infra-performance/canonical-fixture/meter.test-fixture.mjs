import { isFunction, isObjectOrArray, isString } from "effect/Predicate";
/** @typedef {{rowsRead:number,rowsWritten:number}} NativeCursor */
/** @typedef {(...args:unknown[])=>unknown} NativeMethod */
/** @typedef {Record<string,unknown> & {sql:{exec:(query:string,...bindings:unknown[])=>NativeCursor}}} NativeStorage */
/** @typedef {Record<string,unknown>} Bindings */
/** @typedef {new (state:{storage:NativeStorage}, environment:Bindings)=>{fetch(request:Request):Promise<Response>,alarm(...args:unknown[]):Promise<void>}} OwnerClass */

/** @param {unknown} value Reflective native method. @returns {value is NativeMethod} */
const isMethod = (value) => isFunction(value);

const empty = () => ({
  fetches: 0,
  alarms: 0,
  statements: 0,
  rowsRead: 0,
  rowsWritten: 0,
  setAlarm: 0,
  getAlarm: 0,
  deleteAlarm: 0,
  deleteAll: 0,
  otherKv: 0,
  failedSql: 0,
});

/** @type {Map<string, ReturnType<typeof empty>>} */
const owners = new Map();

/** @param {NativeCursor} cursor SQL operation result. @param {ReturnType<typeof empty>} counts Native counters. */
const observedCursor = (cursor, counts) => {
  let reads = 0,
    writes = 0;

  const observe = () => {
    counts.rowsRead += cursor.rowsRead - reads;
    counts.rowsWritten += cursor.rowsWritten - writes;
    reads = cursor.rowsRead;
    writes = cursor.rowsWritten;
  };

  observe();

  /** @param {object} source Native cursor or its iterator. @returns {object} */
  const wrap = (source) => {
    return new Proxy(source, {
      get(target, property) {
        /** @type {unknown} */
        const value = target[property];

        if (!isMethod(value)) return value;

        return (/** @type {unknown[]} */ ...args) => {
          try {
            const result = value.apply(target, args);

            if (property !== "raw" && property !== Symbol.iterator) return result;

            if (!isObjectOrArray(result)) throw Error("SQL cursor did not return an iterator");

            return wrap(result);
          } finally {
            observe();
          }
        };
      },
    });
  };

  return wrap(cursor);
};

/** @param {NativeStorage} storage Native object storage. @param {ReturnType<typeof empty>} counts Native counters. */
const observeStorage = (storage, counts) => {
  const sql = storage.sql,
    exec = sql.exec.bind(sql);

  Object.defineProperty(sql, "exec", {
    value: (/** @type {string} */ query, /** @type {unknown[]} */ ...bindings) => {
      counts.statements++;

      try {
        return observedCursor(exec(query, ...bindings), counts);
      } catch (cause) {
        counts.failedSql++;
        throw cause;
      }
    },
  });

  for (const key of [
    "getAlarm",
    "setAlarm",
    "deleteAlarm",
    "deleteAll",
    "get",
    "put",
    "delete",
    "list",
  ]) {
    const call = storage[key];

    if (!isMethod(call)) throw Error("Missing native storage method");
    Object.defineProperty(storage, key, {
      value: (/** @type {unknown[]} */ ...args) => {
        if (
          key === "getAlarm" ||
          key === "setAlarm" ||
          key === "deleteAlarm" ||
          key === "deleteAll"
        ) {
          counts[key]++;
        } else counts.otherKv++;

        return call.apply(storage, args);
      },
    });
  }
};

/** @type {Map<string,Record<string,number>>} */
const bucketCalls = new Map();

const names = ["SMOKE_BUCKET", "EMAIL_BUCKET", "STATEMENT_STAGING_BUCKET", "SAMPLE_BUCKET"];

const methods = ["get", "head", "list", "put", "delete"];

/** @param {Bindings} environment Original workerd environment. */
export const observedBindings = (environment) => {
  const env = { ...environment };

  for (const name of names) {
    const bucket = env[name];

    if (!bucket) continue;

    if (!isObjectOrArray(bucket)) throw Error("Invalid R2 binding");
    const totals = bucketCalls.get(name) ?? Object.fromEntries(methods.map((key) => [key, 0]));
    bucketCalls.set(name, totals);
    env[name] = new Proxy(bucket, {
      get(target, key) {
        /** @type {unknown} */
        const value = target[key];

        if (!isMethod(value)) return value;

        if (!isString(key) || !methods.includes(key)) {
          throw Error("Unmeasured R2 binding operation");
        }

        return (/** @type {unknown[]} */ ...args) => {
          totals[key]++;

          return value.apply(target, args);
        };
      },
    });
  }

  return env;
};

export const buckets = () => {
  return Response.json(Object.fromEntries(bucketCalls));
};

/** @param {string} name Native Durable Object class name. @param {OwnerClass} Owner Application Durable Object. */
export const observed = (name, Owner) => {
  const counts = empty();
  owners.set(name, counts);

  return class extends Owner {
    /** @param {{storage:NativeStorage}} state Workerd object state. @param {Bindings} env Workerd environment. */
    constructor(state, env) {
      observeStorage(state.storage, counts);
      super(state, observedBindings(env));
    }
    /** @param {Request} request Original fetch request. */
    fetch(request) {
      counts.fetches++;

      return super.fetch(request);
    }
    alarm(/** @type {unknown[]} */ ...args) {
      counts.alarms++;

      return super.alarm(...args);
    }
  };
};

export const totals = () => {
  return Response.json(Object.fromEntries(owners));
};
