# Effect v4 testing seams

Use `@effect/vitest` and the repository's verification groups. For a single file, see
[Focused tests](#focused-tests); for Playwright, see [Browser acceptance](#browser-acceptance).
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

## Browser acceptance

[`playwright.config.ts`](../apps/web/playwright.config.ts) builds the static shell and starts the
public/Core harness. It is separate from Vite development and web Vitest. Before running:

- Use the reviewed Bun runtime required by the CLI and have `openssl` for loopback TLS.
- Install the pinned browser with `bunx --no-install --bun playwright install --only-shell chromium`.
  Linux also requires `bunx --no-install --bun playwright install-deps chromium`.
- Run `bun run --cwd apps/cli test:native` in the same OS session: the full browser suite includes
  a real native-credential CLI journey. Linux requires a running, unlocked DBus/Secret Service;
  macOS uses Keychain and Windows uses Credential Manager. The existing
  [browser CI job](../.github/workflows/ci.yml) shows Linux provisioning. A mock store is not a substitute.
- Check HTTPS web **4173**, API **4174**, and operator fixture **4175**. On macOS/Linux use
  `lsof -nP -iTCP:4173 -iTCP:4174 -iTCP:4175 -sTCP:LISTEN`. Local Playwright can reuse existing
  web/API servers: verify process and worktree ownership, not just a healthy URL. Stop only your
  own stale servers. Do not borrow another session's topology or edit origins/CSP to evade collisions.

```sh
# Full browser gate; the harness builds its own production-mode artifact.
bun run verify -- --group browser

# One spec on the shared topology, with the same prerequisites.
bun run --cwd apps/web test:browser e2e/cli-login.spec.ts

# CLI journey only, on the existing isolated 4183 / 4184 / 4185 topology.
(cd apps/web && CLI_ACCEPTANCE_MODE=cli bun --bun playwright test --config playwright.cli.config.ts)
```

For the isolated command, check ports 4183–4185 instead. Keep `CLI_ACCEPTANCE_MODE=cli` on the
parent so tests, subprocesses, and servers select the same topology. The
[dedicated config](../apps/web/playwright.cli.config.ts) runs only `cli-login.spec.ts`, not the full
gate. If the topology or native service is unavailable, record the limitation. `--list` checks
discovery only; it neither starts servers nor proves browser readiness.

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
