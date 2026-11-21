import { Clock, Effect, Predicate } from "effect";
import { userStoreHistory } from "./user-store/operations";
import { maintenanceStoreHistory } from "./maintenance/operations";
import { erasureStoreHistory } from "./erasure-store/operations";
import { DurableObject } from "cloudflare:workers";
import { createStoreRuntime, openSqliteStore } from "./runtime/sqlite/operations";
import type { StoreHistory } from "./runtime/sqlite/contract";

const initial = {
  version: 1,
  id: "first",
  statements: [
    "CREATE TABLE retained(id INTEGER PRIMARY KEY) STRICT",
    "INSERT INTO retained VALUES (41)",
  ],
};

const second = {
  version: 2,
  id: "second",
  statements: [
    "ALTER TABLE retained ADD COLUMN label TEXT",
    "UPDATE retained SET label='preserved'",
  ],
};

const third = {
  version: 3,
  id: "third",
  statements: [
    "CREATE TABLE result(value INTEGER) STRICT",
    "INSERT INTO result SELECT id+1 FROM retained",
  ],
};

const histories = {
  inspect: [],
  oldest: [initial],
  latest: [initial, second, third],
  busy: [initial, second, third],
  refuseGuard: [initial, second, third],
  missing: [initial, third],
  mismatch: [{ ...initial, statements: ["CREATE TABLE changed(value INTEGER)"] }, second, third],
  invalid: [
    initial,
    second,
    { ...third, statements: [...third.statements, "INSERT INTO absent VALUES(1)"] },
  ],
};

const observeStorage = (
  storage: DurableObjectStorage,
  mode: string,
  sample: (size: number) => void
): DurableObjectStorage => {
  const exec = <Row extends Record<string, SqlStorageValue>>(
    query: string,
    ...bindings: SqlStorageValue[]
  ): SqlStorageCursor<Row> => {
    if (
      (mode === "busy" && query.includes("INSERT INTO result SELECT")) ||
      (mode === "refuseGuard" && query.includes("INSERT INTO store_migration_attempts"))
    ) {
      throw Object.assign(new Error("synthetic busy storage"), { code: "SQLITE_BUSY" });
    }

    const cursor = storage.sql.exec<Row>(query, ...bindings);
    sample(storage.sql.databaseSize);

    return cursor;
  };

  const sql: SqlStorage = {
    exec,
    get databaseSize(): number {
      return storage.sql.databaseSize;
    },
    Cursor: storage.sql.Cursor,
    Statement: storage.sql.Statement,
  };

  const isStorageMember = (property: string | symbol): property is keyof DurableObjectStorage =>
    Predicate.hasProperty(storage, property);

  return new Proxy(storage, {
    get: (target, property) => {
      if (property === "sql") return sql;

      if (!isStorageMember(property)) return undefined;

      const value = target[property];

      return Predicate.isFunction(value) ? value.bind(target) : value;
    },
  });
};

const connectionSchemaVersion = 20;

const owners = {
  userOldest: { ...userStoreHistory, steps: userStoreHistory.steps.slice(0, 1) },
  userBeforeConnections: {
    ...userStoreHistory,
    steps: userStoreHistory.steps.filter((step) => step.version < connectionSchemaVersion),
  },
  userCurrent: userStoreHistory,
  maintenance: maintenanceStoreHistory,
  erasure: erasureStoreHistory,
} as const;

const selectedHistory = (mode: keyof typeof owners | keyof typeof histories): StoreHistory => {
  if (
    mode === "userOldest" ||
    mode === "userCurrent" ||
    mode === "userBeforeConnections" ||
    mode === "maintenance" ||
    mode === "erasure"
  ) {
    return owners[mode];
  }

  return { owner: "user", steps: histories[mode] };
};

type FixtureEnvironment = {
  MODE: keyof typeof owners | keyof typeof histories;
  RELEASE: string;
  NOW: string;
};

export class MigrationProbe extends DurableObject<FixtureEnvironment> {
  private readonly initialBytes: number;
  private peakBytes: number;
  constructor(state: DurableObjectState, env: FixtureEnvironment) {
    super(state, env);
    this.initialBytes = state.storage.sql.databaseSize;
    this.peakBytes = this.initialBytes;

    if (env.MODE === "inspect") return;

    const storage = observeStorage(state.storage, env.MODE, (size) => {
      this.peakBytes = Math.max(this.peakBytes, size);
    });

    const history = selectedHistory(env.MODE);

    const runtime = createStoreRuntime({
      storage,
      owner: history.owner,
      ceilingBytes: "1000000000",
    });

    state.waitUntil(
      state.blockConcurrencyWhile(() =>
        runtime.runPromise(
          Effect.gen(function* () {
            const live = yield* Clock.Clock;
            const now = Number(env.NOW);
            yield* openSqliteStore(history, env.RELEASE).pipe(
              Effect.provideService(Clock.Clock, {
                currentTimeNanos: live.currentTimeNanos,
                currentTimeNanosUnsafe: () => live.currentTimeNanosUnsafe(),
                monotonicTimeNanos: live.monotonicTimeNanos,
                monotonicTimeNanosUnsafe: () => live.monotonicTimeNanosUnsafe(),
                sleep: (duration) => live.sleep(duration),
                currentTimeMillis: Effect.succeed(now),
                currentTimeMillisUnsafe: () => now,
              })
            );
          })
        )
      )
    );
  }
  override fetch(): Promise<Response> {
    const finalBytes = this.ctx.storage.sql.databaseSize;

    return Promise.resolve(
      Response.json({
        initialBytes: this.initialBytes,
        peakBytes: Math.max(finalBytes, this.peakBytes),
        finalBytes,
      })
    );
  }
}
