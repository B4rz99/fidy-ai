import { Miniflare } from "miniflare";
import { type NativeImagePool, nativeImagePool } from "./d1-test-images.test-fixture";
import { asynchronousNativeDatabase } from "./d1-test-bridge.test-fixture";
import { Option, Schema } from "effect";

export const consentHistoryTestSchema =
  "CREATE TABLE IF NOT EXISTS consent_history (sequence INTEGER PRIMARY KEY AUTOINCREMENT, record_type TEXT NOT NULL, id TEXT,user_id TEXT,disclosure_json TEXT,disclosure_message_id TEXT,decision_message_id TEXT,decision_received_at_ms INTEGER,accepted_at_ms INTEGER,grant_record_id TEXT,session_id TEXT,occurred_at_ms INTEGER,withdrawal_id TEXT,grant_id TEXT,offer_id TEXT,record_json TEXT,decision TEXT,kind TEXT,pairing_id TEXT,request_id TEXT,disclosure_revision TEXT,disclosure_text TEXT,grant_consent_id TEXT,pat_id TEXT,policy_reason TEXT,connection_id TEXT,reason TEXT)";

export const auditEntriesTestSchema =
  "CREATE TABLE IF NOT EXISTS audit_entries (sequence INTEGER PRIMARY KEY AUTOINCREMENT,record_type TEXT NOT NULL,id TEXT,user_id TEXT,session_id TEXT,operation TEXT,outcome TEXT,occurred_at_ms INTEGER,pat_id TEXT,oauth_connection_id TEXT,oauth_credential_id TEXT,hosted_turn_id TEXT,attempt_id TEXT,transition TEXT,accepted_at_ms INTEGER,UNIQUE(record_type,id),UNIQUE(attempt_id,transition))";

const migrationStatements = new Map<string, Promise<ReadonlyArray<string>>>();
const schemaInstallers = new WeakMap<D1Database, (sql: ReadonlyArray<string>) => Promise<void>>();
const controlSchemas = new WeakMap<D1Database, Promise<void>>();
const privacySchema = new URL("./migrations/0095_titular_erasure.sql", import.meta.url);
const assertionSchema = new URL("./migrations/0113_sql_assertions.sql", import.meta.url);

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

/** Focused owner fixtures share one metadata-only store; full fixtures install the production constraints. */
export const installAuditTestSchema = (db: D1Database): Promise<void> =>
  db.batch([db.prepare(auditEntriesTestSchema)]).then(() => undefined);

const installControlSchema = ({
  db,
  source,
  table,
}: Readonly<{ db: D1Database; source: URL; table: string }>): Promise<void> =>
  db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?")
    .bind(table)
    .first<string>()
    .then((existing) =>
      existing === null
        ? loadMigrationStatements(source).then((sql) =>
            db.batch(sql.map((statement) => db.prepare(statement)))
          )
        : undefined
    )
    .then(() => undefined);

const installControlSchemas = (db: D1Database): Promise<void> => {
  const installed = controlSchemas.get(db);
  if (installed !== undefined) return installed;
  const pending = installControlSchema({
    db,
    source: privacySchema,
    table: "erasure_requests",
  })
    .then(() => installControlSchema({ db, source: assertionSchema, table: "sql_assertions" }))
    .then(() =>
      loadMigrationStatements(
        new URL("./migrations/0130_specialized_assertions.sql", import.meta.url)
      )
    )
    .then((statements) =>
      db.batch(
        statements
          .filter((sql) => sql.trim().startsWith("CREATE TRIGGER IF NOT EXISTS sql_assertions_"))
          .map((sql) => db.prepare(sql))
      )
    )
    .then(() => undefined);
  controlSchemas.set(db, pending);
  return pending;
};

/** Applies one file in a native transaction after installing the shared control schemas.
 * Only immutable SQL text is cached; every database still executes every migration.
 * Focused current-owner fixtures may select owner statements and their matching DROP statements.
 */
export const applyTestMigration = (
  input:
    | Readonly<{ db: D1Database; source: URL }>
    | Readonly<{ db: D1Database; source: URL; includeStatement: (sql: string) => boolean }>
): Promise<void> => {
  const { db, source } = input;
  return installControlSchemas(db)
    .then(() =>
      source.href === privacySchema.href || source.href === assertionSchema.href
        ? []
        : loadMigrationStatements(source).then((sql) => {
            if (!("includeStatement" in input)) return sql;
            const ownedObjects = new Set(
              sql.filter(input.includeStatement).flatMap((statement) => {
                const name = /^CREATE (?:TRIGGER|VIEW|INDEX) (?:IF NOT EXISTS )?(\w+)/u.exec(
                  statement.trim()
                )?.[1];
                return name === undefined ? [] : [name];
              })
            );
            return sql
              .filter(
                (statement) =>
                  input.includeStatement(statement) ||
                  ownedObjects.has(
                    /^DROP (?:TRIGGER|VIEW|INDEX) (?:IF EXISTS )?(\w+)/u.exec(
                      statement.trim()
                    )?.[1] ?? ""
                  )
              )
              .map(currentConsentReads);
          })
    )
    .then((sql) =>
      sql.length === 0 ? undefined : db.batch(sql.map((statement) => db.prepare(statement)))
    )
    .then(() => undefined);
};

const installForwardingFields = (db: D1Database): Promise<void> =>
  applyTestMigration({
    db,
    source: new URL("./migrations/0153_user_companions.sql", import.meta.url),
    includeStatement: (sql) =>
      sql.startsWith("ALTER TABLE users ADD COLUMN forwarding_") ||
      sql.startsWith("UPDATE users SET forwarding_") ||
      sql.startsWith("CREATE UNIQUE INDEX users_forwarding_") ||
      sql.startsWith("CREATE TRIGGER email_forwarding_addresses_field_") ||
      sql.startsWith("CREATE TRIGGER issue_forwarding_address ") ||
      sql.startsWith("DROP TABLE email_forwarding_addresses"),
  });

/** Focused forwarding fixtures use current Consent guards from production SQL and omit retired Audit caps.
 * Actual migration-boundary tests continue to execute each original file unchanged.
 */
export const applyForwardingFixtureMigration = ({
  db,
  source,
}: Readonly<{ db: D1Database; source: URL }>): Promise<void> =>
  installControlSchemas(db)
    .then(() =>
      Promise.all([
        source.href === privacySchema.href || source.href === assertionSchema.href
          ? Promise.resolve([])
          : loadMigrationStatements(source),
        loadMigrationStatements(new URL("./migrations/0134_consent_history.sql", import.meta.url)),
      ])
    )
    .then(([original, current]) => {
      const statements = original
        .filter(
          (sql) =>
            !/^(?:CREATE|DROP) TRIGGER (?:IF (?:NOT )?EXISTS )?\w*daily_budget\b/u.test(
              sql.trim()
            ) && !sql.includes("canonical_audit_usage")
        )
        .map((statement) => {
          if (
            !statement.includes("onboarding_consent_records") ||
            (source.pathname.split("/").at(-1) ?? "") >= "0134"
          ) {
            return statement;
          }
          const name = /^CREATE TRIGGER (\w+) /u.exec(statement.trim())?.[1];
          if (name !== undefined) {
            const replacement = current.find((sql) =>
              sql.trim().startsWith(`CREATE TRIGGER ${name} `)
            );
            if (replacement === undefined) {
              throw new Error(`Missing current Consent guard: ${name}`);
            }
            return replacement;
          }
          return statement.replaceAll(
            "FROM onboarding_consent_records",
            "FROM (SELECT * FROM consent_history WHERE record_type='processing_grant')"
          );
        });
      return statements.length === 0
        ? undefined
        : db
            .batch(statements.map((sql) => db.prepare(currentConsentReads(sql))))
            .then(() => undefined);
    })
    .then(() =>
      source.pathname.endsWith("/0017_forwarded_email.sql")
        ? installForwardingFields(db)
        : undefined
    );

/** Installs the shared controls and an ordered baseline before seeding a fresh test database.
 * Native pooled Workers retain only the immutable migrated schema and baseline seeds,
 * never a test's rows. An owner-baseline failure rolls back its complete batch. This does not model migration boundaries;
 * tests of file-by-file migration behavior must use applyTestMigration instead.
 */
export const installTestSchema = (
  input: Readonly<{ db: D1Database; sources: ReadonlyArray<URL> }>
): Promise<void> => installTestSchemaWithPrefix({ ...input, prefixStatements: [] });

const currentBaselines = [
  {
    requires: ["0030_weekly_schedules", "0039_reminder_schedules"],
    migrations: ["0136_schedules"],
  },
  { requires: ["0016_budgets"], migrations: ["0132_budget_report_aggregates"] },
  {
    requires: [
      "0032_proactive_transcript",
      "0045_budget_messages_transcript",
      "0049_proactive_message_transcript",
    ],
    migrations: ["0131_proactive_transcript"],
  },
  {
    requires: [
      "0033_canonical_request_protection",
      "0032_commercial_allowances",
      "0064_connection_browser_execution",
      "0035_media_submissions",
      "0027_recurring",
    ],
    migrations: ["0130_specialized_assertions"],
  },
  {
    requires: ["0012_billing_collection", "0107_failed_card_replacement"],
    migrations: ["0124_billing_collection_work", "0144_billing_companions"],
  },
  { requires: ["0007_browser_pairing_email"], migrations: ["0125_browser_pairing_dispatch"] },
  { requires: ["0009_email_replacement"], migrations: ["0126_email_replacement_dispatch"] },
  {
    requires: ["0015_statement_submission", "0079_statement_progress"],
    migrations: ["0127_statement_assertion"],
  },
  { requires: ["0030_payment_enrollment"], migrations: ["0128_payment_assertions"] },
  {
    requires: ["0027_recurring"],
    migrations: [
      "0053_recurring_digest_source",
      "0129_recurring_digest_exclusions",
      "0154_recurring_confirmation",
    ],
  },
  {
    requires: ["0033_weekly_dispatch", "0035_proactivity_governor", "0041_proactivity_messages"],
    migrations: ["0123_proactivity_delivery"],
  },
  {
    requires: [
      "0009_transactions",
      "0014_memory",
      "0016_budgets",
      "0018_dashboard",
      "0009_email_replacement",
      "0019_canonical_child_guards",
    ],
    migrations: ["0122_session_audit"],
  },
  { requires: ["0027_recurring"], migrations: ["0121_recurring_schedule"] },
  { requires: ["0034_statement_clarification_audit"], migrations: ["0115_ingestion_audit"] },
  {
    requires: ["0110_ingestion_review", "0033_statement_clarification"],
    migrations: ["0116_review_decisions"],
  },
  {
    requires: ["0035_media_submissions"],
    migrations: ["0117_media_capacity", "0119_media_review"],
  },
  { requires: ["0034_forwarded_email_deferral"], migrations: ["0120_email_deferral"] },
];
/** Current owner behavior uses the current application schema; historical boundaries use applyTestMigration. */
const currentTestSources = (sources: ReadonlyArray<URL>): ReadonlyArray<URL> => {
  if (sources.some((source) => source.pathname.endsWith("/0005_verified_onboarding.sql"))) {
    return [new URL("./schema.sql", import.meta.url)];
  }
  const names = new Set(sources.map((source) => source.pathname.split("/").at(-1)));
  const additions = currentBaselines
    .filter(({ requires }) => requires.every((name) => names.has(`${name}.sql`)))
    .flatMap(({ migrations }) =>
      migrations.map((name) => new URL(`./migrations/${name}.sql`, import.meta.url))
    );
  return [
    ...new Map([...sources, ...additions].map((source) => [source.href, source])).values(),
  ].sort((left, right) => left.href.localeCompare(right.href));
};

const currentConsentReads = (sql: string): string =>
  sql.replaceAll(
    "FROM consent_user_revocations",
    "FROM (SELECT w.id,w.user_id,w.grant_record_id,w.session_id,w.occurred_at_ms FROM consent_history w WHERE w.record_type='processing_withdrawal' AND NOT EXISTS(SELECT 1 FROM consent_history n WHERE n.record_type='processing_renewal' AND n.withdrawal_id=w.id AND n.user_id=w.user_id))"
  );

const testSchemaStatements = (
  input: Readonly<{ sources: ReadonlyArray<URL>; prefixStatements: ReadonlyArray<string> }>
): Promise<ReadonlyArray<string>> =>
  currentTestSources(input.sources)
    .filter((source) => source.href !== privacySchema.href && source.href !== assertionSchema.href)
    .reduce<Promise<ReadonlyArray<string>>>(
      (previous, source) =>
        previous.then((sql) => loadMigrationStatements(source).then((next) => [...sql, ...next])),
      Promise.resolve(input.prefixStatements)
    )
    .then((sql) =>
      input.sources.some((source) => source.pathname.endsWith("/0005_verified_onboarding.sql"))
        ? sql
        : sql.map(currentConsentReads)
    );

/** Includes current shared controls and the caller's immutable baseline. */
export const installTestSchemaWithPrefix = (
  input: Readonly<{
    db: D1Database;
    sources: ReadonlyArray<URL>;
    prefixStatements: ReadonlyArray<string>;
  }>
): Promise<void> => {
  const install = schemaInstallers.get(input.db);
  if (input.sources.some((source) => source.pathname.endsWith("/0005_verified_onboarding.sql"))) {
    const pending = loadMigrationStatements(new URL("./schema.sql", import.meta.url)).then((sql) =>
      install !== undefined
        ? install([...input.prefixStatements, ...sql])
        : input.db
            .batch(
              [...input.prefixStatements, ...sql].map((statement) => input.db.prepare(statement))
            )
            .then(() => undefined)
    );
    controlSchemas.set(input.db, pending);
    return pending;
  }

  return installControlSchemas(input.db)
    .then(() => testSchemaStatements(input))
    .then((sql) => {
      if (sql.length === 0) return;
      if (install !== undefined) return install(sql);
      return input.db
        .batch(sql.map((statement) => input.db.prepare(statement)))
        .then(() => undefined);
    });
};

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

const reviewTestMigrations = (names: ReadonlyArray<string>): ReadonlyArray<string> => [
  ...(names.includes("0016_statement_processing") ? ["0108_review_suggestions"] : []),
  ...(names.includes("0033_statement_clarification")
    ? ["0018_forwarded_email_processing", "0109_review_state", "0110_ingestion_review"]
    : []),
];

export const canonicalAdmissionMigrationNames = (
  names: ReadonlyArray<string>
): ReadonlyArray<string> =>
  [
    ...new Set([
      ...names,
      ...reviewTestMigrations(names),
      "0095_titular_erasure",
      ...(names.includes("0020_dashboard_projection")
        ? ["0083_transaction_deletion", "0085_budget_contribution_pages"]
        : []),
      ...(names.includes("0029_audit_owner_retention") ? ["0084_transaction_deletion_audit"] : []),
      ...(names.includes("0016_budgets")
        ? [
            "0037_budget_crossing_facts",
            "0038_proactivity_consent",
            "0042_budget_proactivity",
            "0089_budget_month_plans",
            "0090_budget_group_currencies",
          ]
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
      "0106_declined_card_retry",
      "0107_failed_card_replacement",
      "0112_failed_card_wallet_replacement",
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
      "0091_free_email_allowance",
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
  "0077_statement_materialization",
  "0078_statement_materialization_binding",
  "0079_statement_progress",
  "0082_statement_review_capacity",
] as const;
export const statementAuditTestMigrations = [
  "0027_recurring",
  "0028_recurring_audit_budget",
  "0029_audit_owner_retention",
  ...statementClarificationTestMigrations,
] as const;

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
  "0080_whatsapp_sandbox_routing",
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
