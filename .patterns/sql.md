# SQL / Postgres

How Effect v4 SQL support actually works, read from the source. Citations are `<path>:<line>`
relative to `.repos/effect/packages/`. The dialect-agnostic core lives in
`effect/src/unstable/sql/` (`SqlClient`, `Statement`, `SqlSchema`, `SqlResolver`, `SqlModel`,
`Migrator`, `SqlError`, `SqlStream`); the Postgres driver package is `@effect/sql-pg` at
`sql/pg/` (just `PgClient.ts` + `PgMigrator.ts`). There is no ai-docs SQL walkthrough — the
package tests are the canonical usage examples.

## Client construction (PgClient)

`@effect/sql-pg` wraps the **`pg` npm driver** (pure JS — Bun-compatible) plus `pg-cursor`
for streaming and `pg-types` for parsing (`sql/pg/src/PgClient.ts:53-55`,
`sql/pg/package.json:70-75`). platform-bun ships **no** SQL module (only
`sql/sqlite-bun` exists for sqlite); on Bun you use `@effect/sql-pg` as-is.

- `PgClient.layer(config)` / `layerConfig(Config.Wrap<PgPoolConfig>)` provide **both**
  `PgClient` and `SqlClient` tags, with `Reactivity.layer` already baked in
  (`PgClient.ts:779-813`). Handlers should depend on `SqlClient`; reach for `PgClient` only
  for `json`/`listen`/`notify`/`config` (`PgClient.ts:79-85`).
- Config: `url: Redacted` (connection string) **or** parts (`host/port/database/username/
password: Redacted/ssl`); pool knobs `maxConnections`, `minConnections`, `idleTimeout`,
  `connectionTTL`, `connectTimeout` (`PgClient.ts:105-141`). Construction runs `SELECT 1` and
  fails the layer with a classified `SqlError` after `connectTimeout` (default 5s)
  (`PgClient.ts:179-203`). `applicationName` defaults to `"@effect/sql-pg"` (`:173`).
- Casing: `transformResultNames: String.snakeToCamel` + `transformQueryNames:
String.camelToSnake` is the tested idiom (`sql/pg/test/utils.ts:29-38`) — identifiers and
  record-helper keys are snake_cased at compile time, row keys camelCased on read
  (`PgClient.ts:574-583`, `sql/pg/test/Client.test.ts:255-270`). `sql.withoutTransforms()`
  opts out per call site (`effect/src/unstable/sql/SqlClient.ts:178-195`).
- Interruption of an in-flight query issues best-effort `pg_cancel_backend`
  (`PgClient.ts:752-771`; test `Client.test.ts:288-298`).
- `types: Pg.CustomTypesConfig` overrides driver-level OID parsers if ever needed (`:126`).

## The `sql` tag (Statement)

A statement is simultaneously a `Fragment` and an `Effect<ReadonlyArray<A>, SqlError>`, with
`.stream`, `.values` (array-mode rows), `.raw` (driver result: row count etc.),
`.unprepared`, `.withoutTransform`, and `.compile()` (`effect/src/unstable/sql/Statement.ts:70-81`).
Interpolated values become `$n` bind parameters; interpolated fragments/helpers splice in
(`Statement.ts:625-643`); `sql("name")` (a plain string call) is an **escaped identifier**,
double-quoted (`Statement.ts:436,543-545`; `PgClient.ts:864`).

| Helper                                      | Compiles to                                                             | Trap                                                        |
| ------------------------------------------- | ----------------------------------------------------------------------- | ----------------------------------------------------------- |
| `sql.in(col, xs)`                           | `"col" IN ($1,…)`                                                       | empty `xs` → `1=0` (`Statement.ts:1496-1509`)               |
| `sql.insert(rec \| recs)`                   | `("c1","c2") VALUES …`; chain `.returning("*")`                         | columns from the **first** record only (`Statement.ts:871`) |
| `sql.update(rec, omit?)`                    | `"c" = $1, …`; `.returning`                                             | no WHERE — you append it                                    |
| `sql.updateValues(recs, alias)`             | `(values …) AS alias("c")` for bulk update-from (`PgClient.ts:839-846`) |                                                             |
| `sql.and(cs)` / `sql.or(cs)`                | parenthesized chain                                                     | empty → `1=1` (`Statement.ts:693-702`)                      |
| `sql.csv(prefix?, cs)`                      | comma list (ORDER/GROUP BY) (`Statement.ts:711-731`)                    |                                                             |
| `sql.literal(s)` / `sql.unsafe(s, params?)` | raw SQL, unescaped (`Statement.ts:441-446,559-573`)                     | injection escape hatch — params still bind                  |
| `sql.json(x)` (PgClient only)               | bind param carrying JSON (`PgClient.ts:604,847-859`)                    | see transformJson trap below                                |

`undefined` in a record helper binds as `null` (`Statement.ts:1479`). Multi-statement
strings return an **array of row-arrays**, one per statement
(`PgClient.ts:658-663`, test `Client.test.ts:272-286`). Compiled SQL+params are cached on
the statement object (`Statement.ts:826-835`). There is no request batching beyond the
record helpers; batching of _concurrent_ requests is SqlResolver's job.

## Schema integration (SqlSchema — the fidy read/write seam)

`SqlSchema.*` wraps an `execute` callback with request-encode + row-decode
(`effect/src/unstable/sql/SqlSchema.ts`):

| Helper          | Returns              | Empty result                            | Extra rows                                |
| --------------- | -------------------- | --------------------------------------- | ----------------------------------------- |
| `findAll`       | `Array<Res>`         | `[]` (`SqlSchema.ts:33-49`)             | all decoded                               |
| `findNonEmpty`  | `NonEmptyArray<Res>` | fails `NoSuchElementError` (`:65-84`)   | all decoded                               |
| `findOne`       | `Res`                | fails `NoSuchElementError` (`:115-139`) | **silently ignored** — only row 0 decodes |
| `findOneOption` | `Option<Res>`        | `Option.none` (`:148-172`)              | silently ignored                          |
| `void`          | `void`               | n/a (`:86-106`)                         | discarded                                 |

Decode/encode failures surface as **typed `Schema.SchemaError`**, not defects
(`SqlSchema.ts:47`, test `effect/test/unstable/sql/SqlSchema.test.ts:34-44`) — exactly the
"never trust a raw row" seam. `SqlResolver.ordered/grouped/findById/void` are the batched
(`RequestResolver`) versions, deduped by payload equality and **keyed by the active
transaction connection** so batches never leak across transactions
(`effect/src/unstable/sql/SqlResolver.ts:101-139,387-393`); `ordered` fails
`ResultLengthMismatch` when rows ≠ requests (`:128-130`).

Higher level, `Model.Class` (`effect/src/unstable/schema/Model.ts:77-112`) defines one
schema with derived `insert`/`update`/`json` variants (`Model.GeneratedByDb`,
`DateTimeInsertFromDate`/`DateTimeUpdateFromDate`, `UuidV4Insert`, `FieldOption`,
`Sensitive`, `JsonFromString`), and `SqlModel.makeRepository(Model, { tableName, spanPrefix,
idColumn, softDeleteColumn? })` derives insert/update/findById/delete over `insert …
returning *` (`effect/src/unstable/sql/SqlModel.ts:33-221`). Note the repository dies on
missing rows after insert/update (`SqlModel.ts:111,155`). For hand-written SQL, `SqlSchema`

- your own statements is the intended layer; `SqlModel` is optional sugar.

## Column mapping

- **numeric** — the driver returns `numeric` as a **string** (pg-types default); decode with
  `Schema.BigDecimalFromString` (string ⇄ BigDecimal, `effect/src/Schema.ts:10966-10968`).
  Gotcha: empty string decodes to zero (`Schema.ts:10957`). For `Money { amount, currency }`
  flattened to adjacent columns there is no built-in — model the row schema with
  `amount: Schema.BigDecimalFromString, currency: Schema.String` and reconstruct via
  `Schema.decodeTo`/class constructor in the Result schema.
- **timestamptz/timestamp** — driver parses to JS `Date`; decode with
  `Schema.DateTimeUtcFromDate` (validates the Date, yields `DateTime.Utc`, encodes back to
  `Date` — `Schema.ts:12090-12096`). Prefer `timestamptz` columns: the driver parses bare
  `timestamp` in server-local time.
- **jsonb/json** — the driver returns the **already-parsed** object (test
  `Client.test.ts:234-239`), so decode with the domain schema directly
  (`Schema.decodeUnknownEffect` inside a `SqlSchema` Result). Writing: a plain object
  parameter is stringified by the driver; `sql.json(x)` marks it explicitly
  (`PgClient.ts:604`). `Model.JsonFromString` is only for TEXT-typed columns
  (`Model.ts:685-706`).
- **nullability** — `NULL` arrives as `null`; model with `Schema.NullOr(...)` (or
  `Model.FieldOption` for `Option` in app code, `Model.ts:334-356`). No silent defaults.
- **bigint columns** (`int8`) also come back as strings from the driver — decode explicitly.

### Trap: transformJson renames keys inside your jsonb

With `transformResultNames` set, the row transform **recurses into nested objects by
default** — `transformJson` defaults to nested=true (`PgClient.ts:578-583`,
`Statement.ts:1131-1134`), so keys _inside a decoded jsonb document_ get snakeToCamel'd
before your schema sees them; symmetrically `sql.json` payload keys get camelToSnake'd on
write (`PgClient.ts:825-827,847-859`). The test suite shows both behaviors
(`Client.test.ts:107-166`). If jsonb documents must round-trip byte-exact (raw payloads),
pass `transformJson: false` in the client config and keep the column-name transform only.

## Transactions (`sql.withTransaction`)

`makeWithTransaction` (`effect/src/unstable/sql/SqlClient.ts:222-292`):

- Top-level: reserves a dedicated pool connection, `BEGIN`; nested `withTransaction` on the
  same client issues `SAVEPOINT effect_sql_<n>` instead (`SqlClient.ts:149-166,248-254`).
- **Any non-success exit rolls back** — typed failure, defect, or interruption all produce a
  failed `Exit` → `ROLLBACK` (or `ROLLBACK TO SAVEPOINT` when nested) (`:266-283`). The whole
  wrapper runs under `uninterruptibleMask` with only the body restorable (`:233`), so
  commit/rollback can't be interrupted; a failing COMMIT/ROLLBACK itself is `orDie` (`:271,279`).
- **Connection affinity via context**: the reserved connection is stored as a per-client
  `TransactionConnection` service; every statement checks context first (`:140-147,256-263`),
  so all queries inside the body — including forked fibers inheriting context — share the one
  connection (pg serializes them per connection). SqlResolver batches key on this service.
- Acquire failures surface as typed `SqlError` `ConnectionError`, not defects
  (`sql/pg/test/TransactionAcquire.test.ts:23-52`).
- Nested-savepoint success is a no-op (no early RELEASE) (`:272-274`); the transaction gets
  a `sql.transaction` span with commit/rollback events (`:236,270-277`).

This is the fidy "atomic all-or-nothing" primitive: wrap the unit of work, let typed domain
failures propagate — the rollback happens on the way out.

## Errors (SqlError)

Every driver failure is `SqlError { reason: SqlErrorReason }` where the reason is a tagged
class with `cause`, optional `message`/`operation`, and an `isRetryable` getter
(`effect/src/unstable/sql/SqlError.ts:335-421`). Pg SQLSTATE classification
(`PgClient.ts:910-950`): `08*`→ConnectionError(retryable), `28*`→Authentication,
`42501`→Authorization, `42*`→SqlSyntaxError, **`23505`→`UniqueViolation` carrying the
trimmed `constraint` name** (`:930-931`, tests `sql/pg/test/SqlErrorClassification.test.ts:58-75`),
other `23*`→ConstraintError, `40P01`→Deadlock(retryable), `40001`→Serialization(retryable),
`55P03`→LockTimeout, `57014`→StatementTimeout, else UnknownError. For insert-only /
idempotency tables, match `error.reason._tag === "UniqueViolation" && error.reason.constraint
=== "consent_records_pkey"` — the constraint is `"unknown"` when the driver omits it
(`SqlErrorClassification.test.ts:64-74`). `error.isRetryable` delegates to the reason
(`SqlError.ts:418-420`) and pairs with `Effect.retry`.

## Migrator

Core in `effect/src/unstable/sql/Migrator.ts`, Pg wiring in `sql/pg/src/PgMigrator.ts`
(re-exports core, adds `run` + `layer` and pg_dump-based `schemaDirectory` dumps,
`PgMigrator.ts:35-120`). `PgMigrator.layer({ loader })` runs migrations at layer build.

- Migrations are **Effect values requiring `SqlClient`**, not .sql files. Loaders:
  `fromFileSystem(dir)` / `fromGlob(import.meta.glob(...))` expect `<id>_<name>.ts` default-
  exporting an Effect (`Migrator.ts:336-351,406-440`); `fromRecord({ "0001_init": effect })`
  avoids dynamic import entirely (`:383-396`) — the bundler-friendly choice on Bun.
- Ordering by numeric id; duplicate ids fail (`kind: "Duplicates"`, `:239-244`). Ledger
  table `effect_sql_migrations` (`:110,134-143`).
- All pending migrations run in **one transaction**, guarded by `LOCK TABLE … IN ACCESS
EXCLUSIVE MODE` (`:222-226,306`); a concurrent runner hits the insert conflict and exits
  cleanly as `Locked` → logged, returns `[]` (`:261-273,308-311,325-326`).
- **Trap**: ids are inserted into the ledger _before_ the bodies execute (same tx, so a
  failure rolls both back) (`:261-273`), and a failing migration body is converted to a
  **defect** — `Effect.die(MigrationError{kind:"Failed"})` (`:206-218`). Don't try to
  `catchTag` it; the process is meant to crash.

## Queues, LISTEN/NOTIFY, streaming

- **`PersistedQueue` is the native durable-job abstraction.** Read
  `.patterns/persisted-queue.md` before implementing queue publication, claiming, retries,
  crash recovery, schema evolution, or retention. Keep this document focused on the SQL
  substrate rather than duplicating that operational contract.
- **LISTEN/NOTIFY**: `PgClient.listen(channel): Stream<string, SqlError>` on a dedicated
  non-pool connection, and `notify(channel, payload)` via `pg_notify`
  (`PgClient.ts:605-629`; tests `Client.test.ts:319-373`) — usable to cut queue poll latency.
- **Streaming reads**: `statement.stream` uses a `pg-cursor` reading 128-row pages on a
  reserved connection (`PgClient.ts:724-748`) — the tool for large exports/ingestion scans.

## Testing

The repo's own Pg tests run against **Testcontainers**, not the root docker-compose (that
compose file provisions a Postgres for the cluster examples, `docker-compose.yaml:1-10`):
`PgContainer.layerClient` starts `postgres:alpine` per suite and builds `PgClient.layer({
url })` from the container URI (`sql/pg/test/utils.ts:9-48`), consumed via
`it.layer(PgContainer.layerClient, { timeout: "30 seconds" })` (`Client.test.ts:14`). For
fidy's fixed local Postgres (port 5433), the same shape applies with `PgClient.layer`
pointed at the env-provided URL — everything downstream depends only on `SqlClient`, so the
derived-client-against-real-Postgres seam is just a layer swap. Compiler-only assertions
need no database: `.compile()` returns `[sql, params]` synchronously
(`Client.test.ts:15-105`).
