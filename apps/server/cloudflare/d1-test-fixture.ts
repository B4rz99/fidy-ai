import { Miniflare } from "miniflare";
import { Option, Schema } from "effect";

const migrationStatements = new Map<string, Promise<ReadonlyArray<string>>>();
// A binding's bootstrap route follows its identity without retaining the binding or its runtime.
const schemaInstallers = new WeakMap<D1Database, (sql: ReadonlyArray<string>) => Promise<void>>();

const loadMigrationStatements = (source: URL): Promise<ReadonlyArray<string>> =>
  Option.getOrElse(Option.fromUndefinedOr(migrationStatements.get(source.href)), () => {
    const loaded = Bun.file(source)
      .text()
      .then((sql) =>
        sql
          .replace(/^--.*$/gmu, "")
          .trim()
          .split(/;\s*\n(?=PRAGMA |CREATE |ALTER |UPDATE |INSERT |DROP |$)/u)
          .filter((statement) => statement.trim().length > 0)
      );
    migrationStatements.set(source.href, loaded);
    return loaded;
  });

/** Applies checked-in migration statements in order in one D1 transaction per file.
 * Only immutable SQL text is cached; every database still executes every migration.
 */
export const applyTestMigration = ({
  db,
  source,
}: Readonly<{ db: D1Database; source: URL }>): Promise<void> =>
  loadMigrationStatements(source)
    .then((sql) => db.batch(sql.map((statement) => db.prepare(statement))))
    .then(() => undefined);

/** Installs an ordered baseline in one transaction before seeding a fresh test database.
 * Native pooled Workers retain only the immutable migrated schema and baseline seeds,
 * never a test's rows. Failure rolls back the whole schema. This does not model migration boundaries;
 * tests of file-by-file migration behavior must use applyTestMigration instead.
 */
export const installTestSchema = (
  input: Readonly<{ db: D1Database; sources: ReadonlyArray<URL> }>
): Promise<void> => installTestSchemaWithPrefix({ ...input, prefixStatements: [] });

/** Includes immutable caller-owned schema declarations before checked-in migrations. */
export const installTestSchemaWithPrefix = ({
  db,
  sources,
  prefixStatements,
}: Readonly<{
  db: D1Database;
  sources: ReadonlyArray<URL>;
  prefixStatements: ReadonlyArray<string>;
}>): Promise<void> =>
  Array.from(new Map(sources.map((source) => [source.href, source])).values())
    .reduce<Promise<ReadonlyArray<string>>>(
      (previous, source) =>
        previous.then((sql) => loadMigrationStatements(source).then((next) => [...sql, ...next])),
      Promise.resolve(prefixStatements)
    )
    .then((sql) =>
      sql.length === 0
        ? undefined
        : Option.match(Option.fromUndefinedOr(schemaInstallers.get(db)), {
            onNone: () =>
              db.batch(sql.map((statement) => db.prepare(statement))).then(() => undefined),
            onSome: (install) => install(sql),
          })
    )
    .then(() => undefined);

type BindingSlot = Readonly<{ runtime: Miniflare; index: number }>;
// Prepare pooled schema batches inside the Worker instead of crossing the synchronous proxy
// for each statement. Independently wrapped/custom bindings keep the ordinary batch path.
const acquireDatabase = (slot: BindingSlot): Promise<D1Database> =>
  slot.runtime.getD1Database(`DB_${slot.index}`).then((db) => {
    schemaInstallers.set(db, (sql) =>
      slot.runtime
        .dispatchFetch(`http://fixture/DB_${slot.index}`, {
          method: "POST",
          body: sql.join("\u0000"),
        })
        .then((response) => {
          if (!response.ok) throw new Error("Fixture schema installation failed");
        })
    );
    return db;
  });
// Only immutable fixture schema SQL crosses this private local bootstrap route.
const schemaWorker = `
const baselines = new Map();
const installed = new Set();
const identifier = value => '"' + value.replaceAll('"', '""') + '"';
const snapshot = async database => {
  const catalog = (await database.prepare(
    "SELECT type, name, sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' ORDER BY rowid"
  ).all()).results;
  // FTS creates its own shadow tables; replay only its original virtual-table declaration.
  const tableList = (await database.prepare('PRAGMA table_list').all()).results;
  const shadows = new Set(tableList.filter(table => table.type === 'shadow').map(table => table.name));
  const objects = catalog.filter(object => !shadows.has(object.name));
  const tables = objects.filter(object => object.type === 'table');
  const dataTables = tableList.some(table => table.name === 'sqlite_sequence')
    ? [...tables, {name: 'sqlite_sequence'}] : tables;
  const columns = await database.batch(dataTables.map(table =>
    database.prepare('PRAGMA table_info(' + identifier(table.name) + ')')
  ));
  const data = await database.batch(dataTables.map((table, index) => {
    const names = columns[index].results.map(column => identifier(column.name));
    const prefix = 'INSERT INTO ' + identifier(table.name) + '(' + names.join(',') + ') VALUES (';
    const values = names.map(name => 'quote(' + name + ')').join(" || ',' || ");
    return database.prepare('SELECT ? || ' + values + " || ')' AS sql FROM " + identifier(table.name)).bind(prefix);
  }));
  return [
    'PRAGMA defer_foreign_keys = ON',
    ...tables.map(table => table.sql),
    ...data.flatMap((result, index) => [
      ...(dataTables[index].name === 'sqlite_sequence' ? ['DELETE FROM sqlite_sequence'] : []),
      ...result.results.map(row => row.sql),
    ]),
    ...objects.filter(object => object.type !== 'table').map(object => object.sql),
  ];
};
export default {
  async fetch(request, env) {
    const binding = new URL(request.url).pathname.slice(1);
    const database = env[binding];
    if (request.method !== 'POST' || !database) return new Response('missing', {status: 404});
    const statements = (await request.text()).split('\u0000');
    try {
      // Only the first install into a fresh binding can use a pristine baseline.
      // Subsequent schema additions still execute their actual migration statements.
      const pristine = !installed.has(binding) && (await database.prepare(
        "SELECT count(*) AS count FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%'"
      ).first('count')) === 0;
      const baseline = pristine ? baselines.get(statements.join('\\u0000')) : undefined;
      await database.batch((baseline ?? statements).map(sql => database.prepare(sql)));
      if (pristine && !baseline) {
        baselines.set(statements.join('\\u0000'), await snapshot(database));
      }
      installed.add(binding);
      return new Response(null, {status: 204});
    } catch {
      return new Response('Fixture schema installation failed', {status: 500});
    }
  }
}`;

const bindingPool = (
  withBuckets: boolean
): Readonly<{
  acquire: () => BindingSlot;
  dispose: () => Promise<void>;
}> => {
  const runtimes: Miniflare[] = [];
  const poolSize = 16;
  let nextBinding = poolSize;
  let poolSequence = 0;
  let runtime = Option.none<Miniflare>();
  const acquire = (): BindingSlot => {
    if (nextBinding === poolSize) {
      poolSequence += 1;
      const env: Record<string, { type: "d1"; id: string } | { type: "r2"; name: string }> = {};
      for (let index = 0; index < poolSize; index += 1) {
        const name = `isolated-${poolSequence}-${index}`;
        env[`DB_${index}`] = { type: "d1", id: name };
        if (withBuckets) env[`BUCKET_${index}`] = { type: "r2", name };
      }
      const created = new Miniflare({
        workers: [
          {
            config: {
              name: `isolated-${poolSequence}`,
              type: "worker",
              compatibilityDate: "2026-09-08",
              env,
              manifest: {
                mainModule: "index.mjs",
                modules: {
                  "index.mjs": {
                    contents: schemaWorker,
                    type: "esm",
                  },
                },
              },
            },
          },
        ],
      });
      runtimes.push(created);
      runtime = Option.some(created);
      nextBinding = 0;
    }
    return { runtime: Option.getOrThrow(runtime), index: nextBinding++ };
  };
  const dispose = (): Promise<void> =>
    Promise.all(runtimes.splice(0).map((instance) => instance.dispose())).then(() => undefined);
  return { acquire, dispose };
};

/** Reuses a D1-only Worker process, never a database. Each acquisition returns a new binding
 * with independent rows, schema, triggers, and sessions. Call dispose at suite teardown.
 * Tests of Worker/DO lifecycle or runtime restart must keep their own fresh runtime.
 */
export const isolatedTestDatabases = (): Readonly<{
  acquire: () => Promise<D1Database>;
  dispose: () => Promise<void>;
}> => {
  const pool = bindingPool(false);
  return {
    acquire: () => acquireDatabase(pool.acquire()),
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
    acquire: () => {
      const slot = pool.acquire();
      return Promise.all([
        acquireDatabase(slot),
        slot.runtime
          .getBindings<{ [key: `BUCKET_${number}`]: R2Bucket }>()
          .then((bindings) =>
            Option.getOrThrow(Option.fromUndefinedOr(bindings[`BUCKET_${slot.index}`]))
          ),
      ]).then(([db, bucket]) => ({ db, bucket }));
    },
    dispose: pool.dispose,
  };
};

/** Canonical/hosted admission reads live Trial/Subscription standing in the same database. */
export const canonicalAdmissionMigrationNames = (
  names: ReadonlyArray<string>
): ReadonlyArray<string> =>
  [
    ...new Set([
      ...names,
      ...(names.includes("0016_budgets")
        ? ["0037_budget_crossing_facts", "0038_proactivity_consent", "0042_budget_proactivity"]
        : []),
      "0007_browser_pairing_email",
      "0008_support_recovery",
      "0009_card_enrollment",
      "0012_billing_collection",
      "0016_subscription_standing",
      "0030_payment_enrollment",
      "0031_daviplata_enrollment",
      "0035_billing_corrections",
      "0052_weekly_card_renewal",
      "0053_calendar_card_renewal",
      "0058_wallet_renewal",
      "0059_subscription_retries",
      "0060_subscription_cancellation",
      "0016_hosted_turn",
      "0062_pat_activity",
      "0063_connections",
      "0064_connection_browser_execution",
      "0065_connection_attempt_retention",
      "0066_provider_authentication",
      "0067_microsoft_authentication",
      "0068_whatsapp_provider_handoff",
      "0069_retire_email_code_signup",
      "0070_recovery_retention",
      "0071_recovery_admission",
      "0072_disclosure_transport",
      "0073_admission_retention",
      "0032_commercial_allowances",
      "0033_canonical_request_protection",
      "0034_forwarded_email_deferral",
      "0035_media_submissions",
      "0033_oauth_authority",
      "0037_oauth_shared_audit_budget",
      "0038_oauth_confirmation",
    ]),
  ].sort();
/** Shared final clarification schema; processing and the shared Audit base must precede it. */
export const statementClarificationTestMigrations = [
  "0032_statement_capture_entitlement",
  "0033_statement_clarification",
  "0034_statement_clarification_audit",
  "0035_statement_hosted_origin",
  "0036_statement_whatsapp_documents",
] as const;
/** Canonical Audit's full shared-budget dependencies for owner integration harnesses. */
export const statementAuditTestMigrations = [
  "0027_recurring",
  "0028_recurring_audit_budget",
  "0029_audit_owner_retention",
  ...statementClarificationTestMigrations,
] as const;

/** Ordered schema additions shared by isolated D1 integration harnesses across owners. */
export const hostedTurnTestMigrations = [
  "0027_recurring",
  "0021_hosted_confirmation",
  "0022_hosted_mutation_fence",
  "0023_hosted_delivery_refresh",
  "0024_hosted_whatsapp",
  "0025_voice_refusal",
  "0026_whatsapp_recovery",
  "0018_insight_events",
  "0030_weekly_schedules",
  "0031_proactive_whatsapp",
  "0032_proactive_transcript",
  "0033_weekly_dispatch",
  "0034_insight_provider_scope",
  "0035_proactivity_governor",
  "0038_proactivity_consent",
  "0039_reminder_schedules",
  "0041_proactivity_messages",
  "0043_reminder_governor",
  "0044_proactivity_channel",
  "0045_budget_messages_transcript",
  "0046_contextual_offers",
  "0047_proactivity_offer_retention",
  "0048_retire_reminder_outbox",
  "0049_proactive_message_transcript",
  "0050_proactivity_offer_recovery",
  "0051_budget_reconciliation_recovery",
  "0053_recurring_digest_source",
  "0054_recurring_proactivity",
  "0055_recurring_digests",
  "0057_recurring_offer_replacement",
  "0074_hosted_retention",
] as const;

/** Resource regressions use the deployed index choices, triggers and foreign keys together. */
export const installRetentionTestSchema = (db: D1Database): Promise<void> =>
  installTestSchema({
    db,
    sources: Array.from(
      new Bun.Glob("*.sql").scanSync(new URL("./migrations/", import.meta.url).pathname)
    )
      .sort()
      .map((name) => new URL(`./migrations/${name}`, import.meta.url)),
  });

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

/** Observe native D1 work without replacing query execution or its transactional behavior. */
export const observeRetentionCost = (
  db: D1Database
): Readonly<{
  database: D1Database;
  cost: () => Readonly<{ rowsRead: number; rowsWritten: number }>;
  plans: () => Promise<ReadonlyArray<string>>;
}> => {
  let rowsRead = 0;
  let rowsWritten = 0;
  const queries: Array<RetentionQuery> = [];
  const nativeStatements = new WeakMap<D1PreparedStatement, D1PreparedStatement>();
  const preparedQueries = new WeakMap<D1PreparedStatement, RetentionQuery>();
  const record = <Row>(result: D1Result<Row>): D1Result<Row> => {
    rowsRead += result.meta.rows_read;
    rowsWritten += result.meta.rows_written;
    return result;
  };
  const prepare = (sql: string, params: ReadonlyArray<unknown> = []): D1PreparedStatement => {
    const native = db.prepare(sql).bind(...params);
    const statement: D1PreparedStatement = {
      bind: (...values) => prepare(sql, values),
      first: native.first.bind(native),
      raw: native.raw.bind(native),
      all: <Row>() => {
        queries.push({ sql, params });
        return native.all<Row>().then(record);
      },
      run: <Row>() => {
        queries.push({ sql, params });
        return native.run<Row>().then(record);
      },
    };
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
      batch: <Row>(statements: D1PreparedStatement[]): Promise<D1Result<Row>[]> =>
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
          .then((results) => results.map(record)),
    },
    cost: () => ({ rowsRead, rowsWritten }),
    plans: () => explainRetentionPlans(db, queries),
  };
};
