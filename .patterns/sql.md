# Effect SQL and Cloudflare D1 adapter guidance

This reference covers the typed SQL ideas useful for a future Cloudflare D1 adapter. It is not an
invitation to add a local relational runtime. D1 is the only intended relational authority; until its
adapter exists, persistence operations fail closed.

## Query seams

Use `effect/unstable/sql` only behind a shell-owned D1 adapter. Keep SQL construction, row decoding,
column mapping, and failure classification in that adapter. Core modules receive plain domain values
and never import SQL, platform bindings, or database drivers.

Every query must have a bounded input and output. Decode every row with Schema before using it. Map
D1 integer, text, blob, and JSON values explicitly to domain types such as exact Money, UTC timestamps,
identifiers, and bounded JSON. A typed row helper is not proof that an untrusted row has domain shape.

Parameterize values. A raw SQL escape hatch is an adapter-only tool for reviewed static fragments and
must never receive model output, uploaded content, provider text, or user-controlled identifiers.

## Atomic units

A D1 atomic unit owns one domain transition and any required outbox record. Reusable owner operations
must accept a caller-owned unit rather than opening nested units. A Queue or Workflow submission is
not assumed atomic with a D1 commit unless the Cloudflare adapter proves the coupling; use an outbox
and idempotent consumer when work continues after commit.

Do not hold an atomic unit across a provider request. Provider ambiguity is handled by a durable
intent, reconciliation, or Workflow step. Coordination keys belong to a Durable Object, not a local
lock or a database row invented as a replacement.

## Errors and unavailable boundaries

Map platform failures to a closed adapter error set containing safe categories such as unavailable,
conflict, not-found, validation, and resource-limit. Do not expose statements, bindings, credentials,
row contents, or platform topology in errors. If the D1 binding, schema, or required adapter is
missing, return the typed unavailable result; never fall back to a map, array, local queue, or best-
effort write.

## Testing

Portable tests cover schema mapping, atomic decision composition, idempotency, authorization, and
redaction without a platform. Cloudflare adapter tests use an isolated D1 binding and verify commit
and rollback, explicit User isolation, bounded reads, duplicate delivery, and deletion/retention.
An in-memory fake may exercise a pure contract only; it cannot claim persistence, transaction, or
cross-Worker evidence.
