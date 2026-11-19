// Loaded only by the disposable credential-free workerd. The serving bundle has no observer.
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
const owners = new Map();

function observedCursor(cursor, counts) {
  let reads = 0,
    writes = 0;
  const observe = () => {
    counts.rowsRead += cursor.rowsRead - reads;
    counts.rowsWritten += cursor.rowsWritten - writes;
    reads = cursor.rowsRead;
    writes = cursor.rowsWritten;
  };
  // Native counters grow as the application consumes each result, including native raw iterators.
  observe();
  function wrap(source) {
    return new Proxy(source, {
      get(target, property) {
        const value = Reflect.get(target, property, target);
        if (typeof value !== "function") return value;
        return (...args) => {
          try {
            const result = Reflect.apply(value, target, args);
            return property === "raw" || property === Symbol.iterator ? wrap(result) : result;
          } finally {
            observe();
          }
        };
      },
    });
  }
  return wrap(cursor);
}

function observeStorage(storage, counts) {
  const sql = storage.sql,
    exec = sql.exec.bind(sql);
  Object.defineProperty(sql, "exec", {
    value: (...args) => {
      counts.statements++;
      try {
        return observedCursor(exec(...args), counts);
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
    const call = storage[key].bind(storage);
    Object.defineProperty(storage, key, {
      value: (...args) => {
        counts[key in counts ? key : "otherKv"]++;
        return call(...args);
      },
    });
  }
}

export function observed(name, Owner) {
  const counts = empty();
  owners.set(name, counts);
  return class extends Owner {
    constructor(state, env) {
      observeStorage(state.storage, counts);
      super(state, env);
    }
    fetch(request) {
      counts.fetches++;
      return super.fetch(request);
    }
    alarm(...args) {
      counts.alarms++;
      return super.alarm(...args);
    }
  };
}

export function totals() {
  return Response.json(Object.fromEntries(owners));
}
