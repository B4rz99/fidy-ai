# Effect SQL and Cloudflare D1

Sources: `node_modules/effect/src/sql/{SqlClient,Statement,SqlError}.ts` and
`node_modules/@effect/sql-d1/src/D1Client.ts`. Public imports are `effect/sql` and
`@effect/sql-d1/D1Client`. D1 is implemented, not a future persistence adapter.

## Query seams

SQL, row decoding, column mapping, and failure classification belong to Cloudflare adapters.
Core receives domain values, not SQL statements or platform bindings. Parameterize values;
raw fragments are reviewed static adapter code, never user/model/provider-controlled SQL.
Bound both queries and returned rows, and decode driver output with the owned Schema.
A generic row type is not runtime validation.

## Atomicity: batch is not an interactive transaction

`D1Client.batch(statements)` submits a fixed set of statements to native `D1Database.batch`,
returning results in order with each statement's result-name transformation. A statement failure
rolls back the native batch. The D1 driver does **not** support `SqlClient.withTransaction` or
streaming queries; its transaction acquirer defects. Do not copy transaction examples from other
SQL drivers into a D1 adapter.

Fidy's canonical mutation composition already lives in
`apps/server/cloudflare/canonical-operations/internal/mutation-unit.ts` and `batch.ts`.
Extend that owned unit rather than inventing a parallel transaction abstraction. Prepared child
mutations participate in one commit; a child must not independently commit or call a provider.
Authority checks and same-User guards remain part of the mutation design, not an assumption supplied
by the SQL client. Coordination belongs to the existing Durable Object boundary.

A D1 commit and Queue/Workflow submission are separate effects. Retain bounded dispatch intent with
the state change and deliver idempotently. Never hold a unit across a provider call; ambiguous
provider acceptance requires reconciliation, not speculative replay.

## Failure and telemetry boundaries

Map driver/platform failures into the owner's closed safe error set. Missing bindings or required
schema fail closed, with no local persistence fallback. Upstream SQL errors can retain causes and
SQL spans can include query text; do not publish raw errors or adopt default tracing as Fidy's
metadata-only policy. Parameterization is not a telemetry redaction guarantee.

## Evidence

Portable tests cover row codecs, decisions, and error projection. Cloudflare tests prove actual
commit/rollback, same-User isolation, guards, bounded reads, duplicate handling, and retention.
A fake database or SQL compilation assertion cannot establish atomicity or cross-Worker behavior.
