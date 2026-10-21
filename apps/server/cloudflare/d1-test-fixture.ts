import { Miniflare } from "miniflare";
import { type NativeImagePool, nativeImagePool } from "./d1-test-images.test-fixture";
import { asynchronousNativeDatabase } from "./d1-test-bridge.test-fixture";
import { Option, Schema } from "effect";

export const consentHistoryTestSchema =
  "CREATE TABLE IF NOT EXISTS consent_history (sequence INTEGER PRIMARY KEY AUTOINCREMENT, record_type TEXT NOT NULL, id TEXT,user_id TEXT,disclosure_json TEXT,disclosure_message_id TEXT,decision_message_id TEXT,decision_received_at_ms INTEGER,grant_record_id TEXT,session_id TEXT,occurred_at_ms INTEGER,withdrawal_id TEXT,grant_id TEXT,offer_id TEXT,record_json TEXT,decision TEXT,kind TEXT,pairing_id TEXT,request_id TEXT,grant_consent_id TEXT,pat_id TEXT,connection_id TEXT,reason TEXT)";

export const auditEntriesTestSchema =
  "CREATE TABLE IF NOT EXISTS audit_entries (sequence INTEGER PRIMARY KEY AUTOINCREMENT,record_type TEXT NOT NULL,id TEXT,user_id TEXT,session_id TEXT,operation TEXT,outcome TEXT,occurred_at_ms INTEGER,pat_id TEXT,oauth_connection_id TEXT,oauth_credential_id TEXT,hosted_turn_id TEXT,attempt_id TEXT,transition TEXT,accepted_at_ms INTEGER,UNIQUE(record_type,id),UNIQUE(attempt_id,transition))";

const schemaStatements = new Map<string, Promise<ReadonlyArray<string>>>();
const schemaInstallers = new WeakMap<D1Database, (sql: ReadonlyArray<string>) => Promise<void>>();
const completeSchemas = new WeakMap<D1Database, Promise<void>>();
const installedObjects = new WeakMap<D1Database, Set<string>>();
const baseline = new URL("./migrations/0001_schema.sql", import.meta.url);
const loadSchemaStatements = (): Promise<ReadonlyArray<string>> => {
  const previous = schemaStatements.get(baseline.href);
  if (previous !== undefined) return previous;
  const migrations = Array.from(
    new Bun.Glob("*.sql").scanSync({ cwd: new URL("./migrations/", import.meta.url).pathname })
  ).sort();
  const loaded = Promise.all(
    migrations.map((name) => Bun.file(new URL(`./migrations/${name}`, import.meta.url)).text())
  )
    .then((sources) =>
      sources
        .join("\n--> statement-breakpoint\n")
        .split("--> statement-breakpoint")
        .map((statement) => statement.trim())
        .filter((statement) => statement.length > 0 && !statement.startsWith("PRAGMA "))
    )
    .then((statements) =>
      statements.filter(
        (statement, index) =>
          !statement.startsWith("DROP VIEW ") &&
          (!statement.startsWith("CREATE VIEW ") ||
            statements.findLastIndex((other) => objectName(other) === objectName(statement)) ===
              index)
      )
    );
  schemaStatements.set(baseline.href, loaded);
  return loaded;
};
const objectName = (sql: string): string =>
  /^CREATE (?:UNIQUE )?(?:TABLE|INDEX|TRIGGER|VIEW) "?(\w+)"?/u.exec(sql.trim())?.[1] ?? "";
const statementOwner = (sql: string): string =>
  /^CREATE TABLE "?(\w+)"?/u.exec(sql.trim())?.[1] ??
  /^CREATE (?:UNIQUE )?INDEX "?\w+"?\s+ON "?(\w+)"?/u.exec(sql.trim())?.[1] ??
  /^CREATE TRIGGER "?\w+"?[\s\S]*?\bON "?(\w+)"?/u.exec(sql.trim())?.[1] ??
  "";
const tableName = (sql: string): string => {
  const owner = statementOwner(sql);
  return owner.length > 0 ? owner : (/^INSERT INTO "?(\w+)"?/u.exec(sql.trim())?.[1] ?? "");
};
/** Focused owner fixtures stub caller-owned authentication; owner constraints come from the production baseline. */
export const installCurrentTestObjects = ({
  db,
  tables,
  ...input
}:
  | Readonly<{ db: D1Database; tables: ReadonlyArray<string> }>
  | Readonly<{
      db: D1Database;
      tables: ReadonlyArray<string>;
      objects: ReadonlyArray<string>;
    }>): Promise<void> => {
  const objects = "objects" in input ? input.objects : [];
  const complete = completeSchemas.get(db);
  if (complete !== undefined) return complete;
  const installed = installedObjects.get(db) ?? new Set<string>();
  const owned = new Set(tables);
  return loadSchemaStatements().then((sql) => {
    const selected = sql.filter((statement) => {
      const owner = tableName(statement);
      const name = objectName(statement);
      return (
        (owned.has(owner) ||
          owned.has(name) ||
          objects.some((prefix) => name.startsWith(prefix)) ||
          owner.startsWith("erasure_") ||
          owner === "sql_assertions") &&
        !installed.has(name || `seed:${owner}`)
      );
    });
    if (selected.length === 0) return;
    return db.batch(selected.map((statement) => db.prepare(statement))).then(() => {
      for (const statement of selected) {
        installed.add(objectName(statement) || `seed:${tableName(statement)}`);
      }
      installedObjects.set(db, installed);
    });
  });
};
export const installAuditTestSchema = (db: D1Database): Promise<void> =>
  db.batch([db.prepare(auditEntriesTestSchema)]).then(() => undefined);
/** Each isolated native binding installs the complete current schema and seeds exactly once. */
export const installTestSchema = (input: Readonly<{ db: D1Database }>): Promise<void> =>
  installTestSchemaWithPrefix({ ...input, prefixStatements: [] });
export const installTestSchemaWithPrefix = (
  input: Readonly<{ db: D1Database; prefixStatements: ReadonlyArray<string> }>
): Promise<void> => {
  const previous = completeSchemas.get(input.db);
  if (previous !== undefined) return previous;
  const pending = loadSchemaStatements().then((sql) => {
    const names = new Set(sql.map(objectName));
    const prefix = input.prefixStatements.filter((statement) => {
      const name =
        /^CREATE (?:UNIQUE )?(?:TABLE|INDEX|TRIGGER|VIEW) (?:IF NOT EXISTS )?"?(\w+)"?/u.exec(
          statement.trim()
        )?.[1];
      return name === undefined || !names.has(name);
    });
    const statements = [...prefix, ...sql];
    const install = schemaInstallers.get(input.db);
    return install !== undefined
      ? install(statements)
      : input.db
          .batch(statements.map((statement) => input.db.prepare(statement)))
          .then(() => undefined);
  });
  completeSchemas.set(input.db, pending);
  return pending;
};

/** Forwarding owner fixtures keep small caller stubs and install current field guards and receipt constraints. */
export const installForwardingTestSchema = ({
  db,
  tables,
}: Readonly<{ db: D1Database; tables: ReadonlyArray<string> }>): Promise<void> =>
  db
    .batch([
      db.prepare("ALTER TABLE users ADD COLUMN forwarding_address_id TEXT"),
      db.prepare("ALTER TABLE users ADD COLUMN forwarding_local_part TEXT"),
      db.prepare("ALTER TABLE users ADD COLUMN forwarding_issued_at_ms INTEGER"),
    ])
    .then(() =>
      installCurrentTestObjects({
        db,
        tables: [
          "forwarded_email_receipts",
          "canonical_child_guard",
          "commercial_allowance_consumptions",
          "canonical_request_replays",
          ...tables,
        ],
        objects: [
          "users_forwarding_",
          "email_forwarding_addresses_field_",
          "issue_forwarding_address",
        ],
      })
    );

type BindingSlot = Readonly<{ runtime: Miniflare; index: number; images: NativeImagePool }>;
type TestDatabaseTransport = "proxy" | "fetch";
const acquireDatabase = (
  slot: BindingSlot,
  transport: TestDatabaseTransport = "fetch"
): Promise<D1Database> =>
  slot.runtime.getD1Database(`DB_${slot.index}`).then((native) => {
    const db =
      transport === "proxy"
        ? native
        : asynchronousNativeDatabase({
            native,
            nativeAccess: () => slot.images.used(slot.index),
            dispatch: (body) => {
              slot.images.used(slot.index);
              return slot.runtime.dispatchFetch(`http://fixture/DB_${slot.index}/query`, {
                method: "POST",
                // Avoid stale Bun fixture sockets across deadlines; SQL writes are never retried.
                headers: { connection: "close" },
                body,
              });
            },
          });
    const original = (sql: ReadonlyArray<string>): Promise<void> =>
      slot.runtime
        .dispatchFetch(`http://fixture/DB_${slot.index}`, {
          method: "POST",
          body: sql.join("\u0000"),
        })
        .then((response) => {
          if (!response.ok) throw new Error("Fixture schema installation failed");
        });
    schemaInstallers.set(db, (sql) =>
      transport === "proxy"
        ? original(sql)
        : slot.images.install({ index: slot.index, sql, original: () => original(sql) })
    );
    return db;
  });
const schemaWorker = `
export default {
  async fetch(request, env) {
    const path = new URL(request.url).pathname;
    const binding = path.split('/')[1];
    const database = env[binding];
    if (request.method !== 'POST' || !database) return new Response('missing', {status: 404});
    if (path.endsWith('/query')) {
      try {
        const input = await request.json();
        const prepared = input.statements.map(({sql, params}) => database.prepare(sql).bind(...params));
        let value;
        if (input.operation === 'batch') value = await database.batch(prepared);
        else if ((input.operation === 'first' || input.operation === 'firstColumn')) value = await prepared[0].first(input.column);
        else if (input.operation === 'all' || input.operation === 'run') value = await prepared[0][input.operation]();
        else return new Response('missing', {status: 404});
        return Response.json({success: true, value});
      } catch (error) {
        return Response.json({success: false, error: {
          message: error.message,
          ...(error.cause instanceof Error ? {cause: error.cause.message} : {}),
        }});
      }
    }
    const statements = (await request.text()).split('\u0000');
    try {
      await database.batch(statements.map(sql => database.prepare(sql)));
      return new Response(null, {status: 204});
    } catch (error) {
      return new Response(String(error), {status: 500});
    }
  }
}`;

const createBindingRuntime = ({
  directory,
  name,
  env,
}: Readonly<{
  directory: string;
  name: string;
  env: Record<string, { type: "d1"; id: string } | { type: "r2"; name: string }>;
}>): Miniflare =>
  new Miniflare({
    resourcePersistencePath: directory,
    workers: [
      {
        config: {
          name,
          type: "worker",
          compatibilityDate: "2026-09-08",
          env,
          manifest: {
            mainModule: "index.mjs",
            modules: { "index.mjs": { contents: schemaWorker, type: "esm" } },
          },
        },
      },
    ],
  });

const bindingPool = (
  withBuckets: boolean
): Readonly<{
  acquire: () => Promise<BindingSlot>;
  dispose: () => Promise<void>;
}> => {
  const runtimes: Promise<NativeImagePool>[] = [];
  const poolSize = 16;
  let nextBinding = poolSize;
  let poolSequence = 0;
  let runtime = Option.none<Promise<NativeImagePool>>();
  const acquire = (): Promise<BindingSlot> => {
    if (nextBinding === poolSize) {
      poolSequence += 1;
      const env: Record<string, { type: "d1"; id: string } | { type: "r2"; name: string }> = {};
      for (let index = 0; index < poolSize; index += 1) {
        const name = `isolated-${poolSequence}-${index}`;
        env[`DB_${index}`] = { type: "d1", id: name };
        if (withBuckets) env[`BUCKET_${index}`] = { type: "r2", name };
      }
      const name = `isolated-${poolSequence}`;
      const created = nativeImagePool({
        size: poolSize,
        create: (directory) => createBindingRuntime({ directory, name, env }),
        layoutKey: name,
      });
      runtimes.push(created);
      runtime = Option.some(created);
      nextBinding = 0;
    }
    const index = nextBinding++;
    return Option.getOrThrow(runtime).then((images) => ({
      runtime: images.runtime,
      index,
      images,
    }));
  };
  const dispose = (): Promise<void> =>
    Promise.all(runtimes.splice(0).map((instance) => instance.then((pool) => pool.dispose()))).then(
      () => undefined
    );
  return { acquire, dispose };
};

/** Reuses a D1-only Worker process, never a database. Each acquisition returns a new binding
 * with independent rows, schema, triggers, and sessions. Call dispose at suite teardown.
 * Tests of Worker/DO lifecycle or runtime restart must keep their own fresh runtime.
 */
export const isolatedTestDatabases = (
  options: Readonly<{ transport: TestDatabaseTransport }> = { transport: "fetch" }
): Readonly<{
  acquire: () => Promise<D1Database>;
  dispose: () => Promise<void>;
}> => {
  const pool = bindingPool(false);
  return {
    acquire: () => pool.acquire().then((slot) => acquireDatabase(slot, options.transport)),
    dispose: pool.dispose,
  };
};

/** Gives each test an independent D1 database and R2 bucket while amortizing Worker startup.
 * Neither binding is reset or reused. Dispose at suite teardown; tests of runtime restarts
 * and real coordinator bindings must own a fresh Miniflare instance instead.
 */
export const isolatedTestStorage = (): Readonly<{
  acquire: () => Promise<Readonly<{ db: D1Database; bucket: R2Bucket }>>;
  dispose: () => Promise<void>;
}> => {
  const pool = bindingPool(true);
  return {
    acquire: () =>
      pool
        .acquire()
        .then((slot) =>
          Promise.all([
            acquireDatabase(slot),
            slot.runtime
              .getBindings<{ [key: `BUCKET_${number}`]: R2Bucket }>()
              .then((bindings) =>
                Option.getOrThrow(Option.fromUndefinedOr(bindings[`BUCKET_${slot.index}`]))
              ),
          ]).then(([db, bucket]) => ({ db, bucket }))
        ),
    dispose: pool.dispose,
  };
};

/** Resource regressions use deployed indexes, triggers and foreign keys together. */
export const installRetentionTestSchema = (db: D1Database): Promise<void> =>
  installTestSchema({ db });

type RetentionQuery = Readonly<{ sql: string; params: ReadonlyArray<unknown> }>;
const explainRetentionPlans = (
  db: D1Database,
  queries: ReadonlyArray<RetentionQuery>
): Promise<ReadonlyArray<string>> =>
  Promise.all(
    queries.map(({ sql, params }) =>
      db
        .prepare(`EXPLAIN QUERY PLAN ${sql}`)
        .bind(...params)
        .all()
        .then((result) =>
          Schema.decodeUnknownSync(Schema.Array(Schema.Struct({ detail: Schema.String })))(
            result.results
          ).map(({ detail }) => detail)
        )
    )
  ).then((plans) => plans.flat());

const observeRetentionStatement = ({
  native,
  query,
  bind,
  queries,
  record,
}: Readonly<{
  native: D1PreparedStatement;
  query: RetentionQuery;
  bind: (values: ReadonlyArray<unknown>) => D1PreparedStatement;
  queries: Array<RetentionQuery>;
  record: <Row>(result: D1Result<Row>, discovery: boolean, query: RetentionQuery) => D1Result<Row>;
}>): D1PreparedStatement =>
  new Proxy(native, {
    get(target, property): unknown {
      if (property === "bind") {
        return (...values: Parameters<D1PreparedStatement["bind"]>) => bind(values);
      }
      if (property === "all" || property === "run") {
        return () => {
          queries.push(query);
          return target[property]().then((result) => record(result, property === "all", query));
        };
      }
      if (property === "first") {
        return (column?: string) => {
          queries.push(query);
          return target.all().then((result) => {
            const row = record(result, false, query).results[0];
            if (row === undefined) return null;
            if (column === undefined) return row;
            if (row[column] === undefined) {
              throw Error(`D1_COLUMN_NOTFOUND: Column not found (${column})`, {
                cause: Error("Column not found"),
              });
            }
            return row[column];
          });
        };
      }
      const value: unknown = Reflect.get(target, property);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });

const retentionBatch =
  ({
    db,
    queries,
    nativeStatements,
    preparedQueries,
    record,
  }: Readonly<{
    db: D1Database;
    queries: Array<RetentionQuery>;
    nativeStatements: WeakMap<D1PreparedStatement, D1PreparedStatement>;
    preparedQueries: WeakMap<D1PreparedStatement, RetentionQuery>;
    record: <Row>(
      result: D1Result<Row>,
      discovery: boolean,
      query: RetentionQuery
    ) => D1Result<Row>;
  }>): D1Database["batch"] =>
  <Row>(statements: D1PreparedStatement[]): Promise<D1Result<Row>[]> =>
    db
      .batch<Row>(
        statements.map((statement) => {
          const query = preparedQueries.get(statement);
          if (query !== undefined) queries.push(query);
          return Option.getOrElse(
            Option.fromUndefinedOr(nativeStatements.get(statement)),
            () => statement
          );
        })
      )
      .then((results) =>
        results.map((result, index) => {
          const statement = Option.getOrThrow(Option.fromUndefinedOr(statements[index]));
          const query = Option.getOrThrow(Option.fromUndefinedOr(preparedQueries.get(statement)));
          return record(result, false, query);
        })
      );

/** Count native all/first/run/batch work; discovery counts standalone all calls, excluding plans. */
export const observeRetentionCost = (
  db: D1Database
): Readonly<{
  database: D1Database;
  cost: () => Readonly<{ rowsRead: number; rowsWritten: number }>;
  discovery: () => number;
  statements: () => ReadonlyArray<Readonly<{ sql: string; rowsRead: number; rowsWritten: number }>>;
  plans: () => Promise<ReadonlyArray<string>>;
}> => {
  let rowsRead = 0;
  let rowsWritten = 0;
  let discoveryReads = 0;
  const statementCosts: Array<Readonly<{ sql: string; rowsRead: number; rowsWritten: number }>> =
    [];
  const queries: Array<RetentionQuery> = [];
  const nativeStatements = new WeakMap<D1PreparedStatement, D1PreparedStatement>();
  const preparedQueries = new WeakMap<D1PreparedStatement, RetentionQuery>();
  const record = <Row>(
    result: D1Result<Row>,
    discovery: boolean,
    query: RetentionQuery
  ): D1Result<Row> => {
    statementCosts.push({
      sql: query.sql,
      rowsRead: result.meta.rows_read,
      rowsWritten: result.meta.rows_written,
    });
    if (discovery) discoveryReads += result.meta.rows_read;
    rowsRead += result.meta.rows_read;
    rowsWritten += result.meta.rows_written;
    return result;
  };
  const prepare = (sql: string, params: ReadonlyArray<unknown> = []): D1PreparedStatement => {
    const native = db.prepare(sql).bind(...params);
    const statement = observeRetentionStatement({
      native,
      query: { sql, params },
      bind: (values) => prepare(sql, values),
      queries,
      record,
    });
    nativeStatements.set(statement, native);
    preparedQueries.set(statement, { sql, params });
    return statement;
  };
  return {
    database: {
      prepare,
      exec: db.exec.bind(db),
      dump: db.dump.bind(db),
      withSession: db.withSession.bind(db),
      batch: retentionBatch({ db, queries, nativeStatements, preparedQueries, record }),
    },
    cost: () => ({ rowsRead, rowsWritten }),
    discovery: () => discoveryReads,
    statements: () => statementCosts,
    plans: () => explainRetentionPlans(db, queries),
  };
};

/** Uses the coordinator harness's query endpoint without replacing its database or Durable Objects. */
export const coordinatorTestDatabase = ({
  runtime,
  binding,
}: Readonly<{ runtime: Miniflare; binding: "DB" | "SNAPSHOT_DB" }>): Promise<D1Database> =>
  runtime.getD1Database(binding).then((native) =>
    asynchronousNativeDatabase({
      native,
      nativeAccess: () => undefined,
      dispatch: (body) =>
        runtime.dispatchFetch(`http://fixture/${binding}/query`, {
          method: "POST",
          headers: { connection: "close" },
          body,
        }),
    })
  );
