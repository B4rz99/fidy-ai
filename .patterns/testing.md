# Effect v4 testing seams

Use `@effect/vitest` and the repository's verification groups. Tests prove the smallest stable seam;
they do not recreate a removed production authority.

## Test styles

- `it.effect` is the default for Effect programs and receives deterministic TestClock and TestConsole
  layers where configured.
- `it.live` opts into live platform behavior and must be used only for an explicit adapter test.
- `it.layer`/`it.scoped` prove Layer construction, memoization, resource release, and failure.
- Pure domain tests call schemas and decisions directly without shell or platform bindings.

Use Schema-driven fixtures, `Exit`/`Cause`/`Equal` assertions, and exact safe failure categories.
Avoid broad snapshots of Effect internals or generated implementation details.

## Boundaries

Core tests prove domain transitions, authorization, retention, redaction, and validation. Contract
tests prove reflected operation ids, access metadata, OpenAPI, browser declarations, and compatibility
artifacts. Provider tests use the published transport contract and deterministic bounded responses.
Browser tests use explicit HTTP fixtures and the built static shell.

Cloudflare adapter tests are the only evidence for D1 atomicity, Durable Object coordination, Queue
redelivery, Workflow suspension/retry, R2 retrieval, Email Worker admission, Workers AI behavior,
and Worker version configuration. Use isolated platform bindings and assert commit/rollback,
redelivery, explicit User isolation, resource limits, deletion, and safe telemetry.

A fake in-memory store may test a pure algorithm, but it cannot claim persistence, locks, durable
queues, cross-Worker isolation, or crash recovery. Tests whose only owner was a deleted runtime or
provider implementation are removed rather than replaced with a local fake.

## Async and cleanup

Fork only when the test owns the fiber; use scoped forks so interruption and layer teardown close all
resources. Advance TestClock instead of sleeping in deterministic tests. Await every assertion and
restore environment/configuration in teardown.

When a test fails, inspect the full Cause and preserve the typed failure boundary. Do not assert on
secret values, raw provider bodies, prompts, replies, uploaded content, or implementation stack
traces.
