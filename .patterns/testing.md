# Effect v4 testing seams

Use `@effect/vitest` and the repository's verification groups. For a single file, see
[Focused tests](#focused-tests).
Selected sources are
`node_modules/@effect/vitest/src/index.ts` and `src/internal/internal.ts` in that package, plus
`node_modules/effect/src/testing/TestClock.ts`. Tests prove the smallest stable seam; they do not
recreate a removed production authority.

## Focused tests

Run commands from the repository root; test paths are **relative to the selected workspace**.
`bun run verify` runs the default groups defined in [`scripts/verify.ts`](../scripts/verify.ts).
Select a gate with `bun run verify -- --group unit` (or another group); mutation testing is opt-in
through `--group mutation`.

| Test location                                                 | Command from repository root                                          |
| ------------------------------------------------------------- | --------------------------------------------------------------------- |
| `apps/server/src/core/`                                       | `bun run --cwd apps/server test:core <path> --coverage.enabled=false` |
| `apps/server/src/shell/` (including canonical catalog/policy) | `bun run --cwd apps/server test <path> --coverage.enabled=false`      |
| `apps/server/src/shell/channels/whatsapp/`                    | `bun run --cwd apps/server test:whatsapp <path>`                      |
| `apps/server/src/shell/ingestion/`                            | `bun run --cwd apps/server test:email-interpretation <path>`          |
| `apps/server/cloudflare/`                                     | `bun run --cwd apps/server test:cloudflare <path>`                    |
| `apps/server/tools/contracts/`                                | `bun run --cwd apps/server test:contracts <path>`                     |
| `apps/web/src/` or web script tests                           | `bun run --cwd apps/web test <path>`                                  |
| `apps/cli/src/`                                               | `bun run --cwd apps/cli test <path>`                                  |
| `infra/cloudflare/`                                           | `bun run --cwd infra/cloudflare test <path>`                          |

```sh
bun run --cwd apps/server test:core src/core/_shared/money.test.ts --coverage.enabled=false
bun run --cwd apps/server test src/shell/canonical-catalog/contract.test.ts --coverage.enabled=false
bun run --cwd apps/web test src/transport/client.test.ts
```

`test:core` only includes core tests. Server `test:contracts` covers artifact-checker tests in
`tools/contracts`, not every `contract.test.ts`. “No test files found” requires checking the selected
config's `include`/`exclude` and path, not changing the suite or claiming success.

Core and general server configs enable whole-scope coverage. Disable it only for focused iteration;
then run the relevant unfiltered gate with normal coverage. A focused pass is not full verification.

## Test styles

- `it.effect` is the default for Effect programs and receives deterministic TestClock and TestConsole
  layers where configured.
- `it.live` opts into live platform behavior and must be used only for an explicit adapter test.
- `it.layer` supplies shared Layer construction; `it.effect` and `it.live` already provide a Scope.
  There is no separate `it.scoped` API in the selected release. Use an explicit inner
  `Effect.scoped` when an assertion must observe finalization before the test ends.
- Pure domain tests call schemas and decisions directly without shell or platform bindings.

Use Schema-driven fixtures, `Exit`/`Cause`/`Equal` assertions, and exact safe failure categories.
Avoid broad snapshots of Effect internals or generated implementation details.

## Boundaries

Run locally available first-party decisions, codecs, and service composition through their real
implementations. Substitute the external transport or platform binding at the smallest owned seam.
For local-only behavior such as byte counting, use a binding that fails if external work is attempted.
Keep deliberate defective-collaborator fixtures when testing defect containment, and narrow fakes
when proving forbidden effects; these are different evidence from a successful integration path.

Core tests prove domain transitions, authorization, retention, redaction, and validation. Contract
tests prove reflected operation ids, access metadata, OpenAPI, browser declarations, and compatibility
artifacts. Provider tests use the published transport contract and deterministic bounded responses.

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

Register cleanup before assertions or interruptible work. Acquire an explicit test Scope with
`Effect.acquireRelease` when an early close is itself under test, so failure still closes it;
see [the clipboard tests](../apps/web/src/browser/clipboard.test.ts). Coordinate races with
Deferreds or controlled transport settlement, then assert both the result and owner disposal.
An abort test must abort the real request while the competing operation is blocked.

When a test fails, inspect the full Cause and preserve the typed failure boundary. Do not assert on
secret values, raw provider bodies, prompts, replies, uploaded content, or implementation stack
traces.
