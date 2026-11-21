# Effect SQL and Durable Object SQLite

Sources: `node_modules/effect/src/sql/{SqlClient,Statement,SqlError}.ts` and
`node_modules/@effect/sql-sqlite-do/src/SqliteClient.ts`. Import the owner-local
`SqliteClient` service from `@effect/sql-sqlite-do/SqliteClient`. The store Runtime supplies
the Durable Object’s own SQLite storage.

## Query seams

SQL, row decoding, column mapping, and failure classification belong to Cloudflare adapters.
Core receives domain values, not SQL statements or platform bindings. Parameterize values;
raw fragments are reviewed static adapter code, never user/model/provider-controlled SQL.
Bound both queries and returned rows, and decode driver output with the owned Schema.
A generic row type is not runtime validation.

## Atomicity

Use the owner’s SQLite transaction to read the current state and commit guarded mutations,
accounting, and Audit together. Compose canonical children through the existing mutation unit
in [the User Store batch planner](../apps/server/cloudflare/canonical-admission/internal/local-batch.ts).
Prepared children must neither commit independently nor call a provider. Recheck live authority
and preserve the User boundary for every child.

SQLite commit and Queue or Workflow submission are separate effects. Retain the dispatch intent
with the state change and deliver idempotently. Reconcile uncertain provider outcomes outside
the transaction.

## Failure and telemetry boundaries

Map driver/platform failures into the owner's closed safe error set. Missing bindings or required
schema fail closed, with no local persistence fallback. Upstream SQL errors can retain causes and
SQL spans can include query text; do not publish raw errors or adopt default tracing as Fidy's
metadata-only policy. Parameterization is not a telemetry redaction guarantee.

## Evidence

Portable tests cover row codecs, decisions, and error projection. Cloudflare tests prove actual
commit/rollback, same-User isolation, guards, bounded reads, duplicate handling, and retention.
A fake database or SQL compilation assertion cannot establish atomicity or cross-Worker behavior.
