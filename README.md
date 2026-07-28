# fidy-ai

## Architecture

`src/` is two trees, each sliced by capability: **`core/`** holds pure business rules typed
`Effect<A, E, never>`, **`shell/`** holds everything that touches the world. Shell may import core;
core may never import shell. See **[`ARCHITECTURE.md`](./ARCHITECTURE.md)** for the shape and the
reasoning, and **[`CODING_STANDARDS.md`](./CODING_STANDARDS.md)** for how code is written inside it.

The canonical API follows a **define operations once** rule: each operation's schemas are defined once in
its slice's core model, its operation once in the slice's shell operation definition (Effect v4 HttpApi,
`effect/unstable/httpapi`), and the HTTP server, the fully-typed client and the OpenAPI spec
(served at `/openapi.json`) are all derived from that single definition. Every success response is
given the universal `{ data, next }` response shape by one shared combinator.

Persistence is PostgreSQL only: pure-JS driver (`@effect/sql-pg`), Effect migrator over one
globally-ordered log under `src/shell/db/migrations/`, hand-written SQL, and every row decoded
through Effect Schema.

### Running

```sh
docker compose up -d db     # local Postgres on :5433
DATABASE_URL=postgres://fidy:fidy@localhost:5433/fidy bun src/main.ts
```

### Testing

Two tiers, and **the tier is decided by which tree the test is in**, not by a naming convention.

Tests under `src/core/` are pure — no server, no database, no Docker:

```sh
bun run test:core
```

Tests under `src/shell/` run at the **API seam**: canonical operations through the derived typed
client against the real handler stack and a real Postgres (`src/shell/testing/api-harness.ts`). They
run with [@effect/vitest](https://www.npmjs.com/package/@effect/vitest) under vitest on the Bun runtime
(`bun --bun vitest`), matching production — the seam serves over a Bun HTTP server. They need
`DATABASE_URL`:

```sh
docker compose up -d db
DATABASE_URL=postgres://fidy:fidy@localhost:5433/fidy bun run test
```

Migration bodies only execute against a database that has not yet had them applied, so coverage
reads low on a warm database. Reset with `docker compose down -v && docker compose up -d db` before
judging a coverage number.

## Toolchain

- **Runtime / package manager:** [Bun](https://bun.sh) (`packageManager` pinned in `package.json`).
  `bunfig.toml` uses a hoisted linker and a 7-day supply-chain delay on new releases. Every
  directory with its own install — the root and each of `tools/*` — carries that delay in its own
  bunfig, and `bun run lint:dependencies` fails if one of them stops.
- **Dependency policy:** `scripts/check-dependency-updates.ts`, run by `bun run lint:dependencies`
  in CI and in `bun run verify`. It asks the npm registry what has shipped since each pin was
  written and grades by the size of the step: a patch, a minor, or a prerelease whose stable
  release has landed is a compatible update the repo simply has not taken, so it **fails**; a major
  is breaking and needs a human with a changelog, so it is reported and CI stays **green**. Specs
  must be exact — with a range, the installed version lives in the lockfile and the check would be
  grading a number nobody wrote down. An update that genuinely cannot be taken yet goes in
  `dependency-policy.json` with a reason and an expiry date, which downgrades it to a warning
  rather than hiding it. The same file records the case where the delay and the `SCA` job want
  opposite things: when the only version without a CVE is younger than the delay, the delay wins —
  it is the control that stops a compromised release, and it blocks even an exact pin — so the
  vulnerability is carried rather than the delay weakened. An `sca.exclusions` entry in
  `.fluidattacks/sca.yaml` stops the scanner counting that one advisory in that one lockfile, and a
  matching `acceptedVulnerabilities` entry carries the reason and the expiry the scanner's config
  has nowhere to put. An exclusion nothing records fails the check, an expired record fails, and so
  does a record whose exclusion has since been removed — as does any `minimumReleaseAgeExcludes`
  entry, which has no escape hatch at all and appears in no bunfig for that reason.
- **Linter:** [oxlint](https://oxc.rs) — one config, `.oxlintrc.json`, run twice: plain, and again
  with `--type-aware` for the rules that need type information. Both run in CI and in
  `bun run verify`. Custom Effect/SQL guards live in `scripts/oxlint/effect-guards.js`.
  `bun run lint:suppressions` guards the guard: a whole-file `oxlint-disable` turns off every
  rule in that file — including one written to catch the directive — so the ban on suppression
  comments has to live outside the linter, in `scripts/check-lint-suppressions.ts`.
- **Module-graph linter:** [dependency-cruiser](https://github.com/sverweij/dependency-cruiser) —
  `.dependency-cruiser.mjs`, run by `bun run lint:deps` in CI and in `bun run verify`. oxlint holds
  the per-file rules; the cruiser holds the ones about the graph, where the target has to be written
  in terms of the source — "a core slice may not import a _sibling_ core slice" is one relational
  rule there and one override block per slice in oxlint. It also generates ARCHITECTURE.md's
  dependency diagram, and the gate fails if that diagram has gone stale.
- **Formatter:** [oxfmt](https://oxc.rs) — configured in `.oxfmtrc.json`.
- **Type checker:** TypeScript 7 native (`typescript@7`, `tsconfig.json`, strict), patched with
  the Effect language service via [`@effect/tsgo`](https://github.com/Effect-TS/tsgo): the
  `postinstall` script runs `effect-tsgo patch` on every `bun install` to swap the `tsc` binary
  for the Effect-aware build. Every Effect diagnostic is configured at `error` severity in
  `tsconfig.json`, and Effect diagnostics fail the typecheck exit code.
- **Git hooks:** [lefthook](https://lefthook.dev) — lint/format on staged files and a
  commit-message convention check.

### Common scripts

| Command                     | What it does                                                      |
| --------------------------- | ----------------------------------------------------------------- |
| `bun run lint`              | oxlint                                                            |
| `bun run lint:type-aware`   | oxlint with the type-aware rules                                  |
| `bun run lint:suppressions` | reject lint-suppression comments in first-party source            |
| `bun run lint:deps`         | module-graph rules + the generated graph                          |
| `bun run lint:dependencies` | pins behind the registry, and the install delay                   |
| `bun run graph`             | regenerate ARCHITECTURE.md's dependency diagram                   |
| `bun run format`            | Format the repo with oxfmt                                        |
| `bun run format:check`      | Verify formatting without writing                                 |
| `bun run typecheck`         | `tsc --noEmit` (Effect-patched)                                   |
| `bun run test`              | `bun --bun vitest run` (needs `DATABASE_URL`)                     |
| `bun run test:core`         | the pure core tier — no Docker, no database                       |
| `bun run test:crap`         | CRAP-score gate (needs `DATABASE_URL`)                            |
| `bun run test:mutation`     | mutation-score gate over `src/core` (no database)                 |
| `bun run verify`            | all rows above except `graph`, `format`, `test:core`, `test:crap` |

### Quality gates

Three test-based gates run on every pull request, with mutation testing shifted right to a nightly
check on `trunk`. They cover the behavioural source listed in `source-scope.mjs` (tests, the
`src/shell/testing` harness, and `src/main.ts` are out of scope):

- **Total coverage** — `bun run test` fails if line coverage over `src/core` and
  `src/shell` drops below 90%.
- **Core coverage** — `bun run test:core` fails if line coverage over `src/core`
  alone drops below 90%.
- **CRAP score** — `bun run test:crap` fails if any function's [CRAP score](https://www.npmjs.com/package/crap4ts)
  exceeds 8 (high complexity + low coverage).
- **Mutation score** — the nightly and manually dispatchable Mutation workflow runs
  `bun run test:mutation` against `trunk` and fails if a single mutant
  [Stryker](https://stryker-mutator.io) plants in `src/core` survives the core tests. The threshold
  remains 100, but its runtime no longer delays or blocks pull requests.

`bun run verify` runs total coverage and mutation testing locally, not the core-coverage or CRAP
commands, so a clean `verify` is still not a clean pull-request run.

The mutation check runs the tests the way everything else here does — through
`bun --bun vitest`, via Stryker's **command** runner rather than its vitest
runner, so a mutant is judged on the runtime that would have shipped it. Only
the Stryker process itself is Node's; its Babel instrumenter throws on Bun.

It is scoped to `src/core`, and to two mutators fewer than Stryker plants:
`StringLiteral` and `ObjectLiteral` are excluded in `stryker.config.mjs` because
in a tree that is mostly schema declaration they overwhelmingly rewrite
`annotate({ description: … })` prose, which reaches a caller only through the
derived OpenAPI spec. That exclusion also hides two real mutants (the
`Direction` literals and the currency literal), which
`src/core/transactions/model.test.ts` covers by hand. Why the shell is measured
but not gated is in ARCHITECTURE.md §8.

Coverage uses the **istanbul** provider, not v8: v8 reads coverage from Node's
V8 inspector, which the Bun runtime does not expose, so `bun --bun vitest
--coverage` would report 0%. istanbul instruments the source directly.

`crap4ts` parses with the classic TypeScript compiler API, which the repo's
Effect tsgo `typescript` build does not expose, so the analyzer and a classic
`typescript` live in an isolated install under `tools/crap/`. `dependency-cruiser`
needs the same API to read `.ts` sources and the tsconfig `paths` aliases, and
gets the same treatment under `tools/depcruise/` — without it the cruiser cruises
zero modules and still exits 0, so its runner fails loudly on an empty cruise
rather than reporting a clean graph nobody looked at. Stryker needs that API too,
to rewrite the sandbox tsconfig, and lives under `tools/mutation/` for the same
reason. It is also the one tool here that runs on **Node** rather than Bun: its
Babel instrumenter throws on the Bun runtime, so `tools/mutation/run.mjs` refuses
to start there instead of failing inside `@babel/core`.

## Commit convention

Commit messages are enforced by the git hooks and must follow:

```
type(scope): summary

- body bullet
- another body bullet
```

**The lists below are the allowlist itself, not a description of one.**
`scripts/check-commit-message.ts` parses this section, and every consumer reads it from there:
the `commit-msg` hook, the `pre-push` hook and the `PR Title` CI check. The hook prints it back
on failure, so a rejected message can be fixed without leaving the terminal. Edit here and all
of them move together — which is why the tables carry `<!-- commit-scopes:… -->` markers.

`type` is one of:

<!-- commit-types -->

`feat` · `fix` · `refactor` · `chore` · `docs` · `test` · `ci`

`scope` names the part of the domain that changed. A commit almost always lands in exactly one
of the thirteen slices (`ARCHITECTURE.md` §2), because a slice's pure half and its impure half
change together:

<!-- commit-scopes:slices -->

| scope          | when to use                                      |
| -------------- | ------------------------------------------------ |
| `identity`     | users, channel identities, sessions              |
| `consent`      | consent records and revocations (Ley 1581)       |
| `transactions` | the ledger, source attestations, reconciliation  |
| `categories`   | the spending taxonomy and its keyword rules      |
| `budgets`      | monthly caps per category and their alerts       |
| `recurring`    | recurring series detected from history           |
| `dashboard`    | the dashboard read model                         |
| `insights`     | insight events — what is worth telling the user  |
| `ingestion`    | capture into transactions, review queue, samples |
| `tokens`       | agent tokens and their scopes                    |
| `audit`        | the metadata-only audit trail                    |
| `memory`       | transcript, rolling summary, user notes          |
| `billing`      | subscriptions, the paywall, payment rails        |

Work that belongs to no slice takes a cross-cutting scope:

<!-- commit-scopes:cross-cutting -->

| scope      | when to use                                                             |
| ---------- | ----------------------------------------------------------------------- |
| `api`      | the API assembly, shared response schemas, transport and authz concerns |
| `channels` | vendor adapters — WhatsApp, inbound email, payment callbacks            |
| `agent`    | the hosted agent loop and its harness                                   |
| `frontend` | the web app                                                             |
| `db`       | schema, migrations, the SQL client                                      |
| `repo`     | repo-wide tooling, config, hooks, CI                                    |
| `deps`     | dependency bumps                                                        |
| `docs`     | documentation                                                           |

`api`, `channels` and `agent` are shell-only areas that own no aggregate, so they are not slices
(`ARCHITECTURE.md` §2) — but code lands in them, so they need a scope.

Body lines must be `-` bullets — non-bullet lines (including trailers) are rejected.

### Merges

PRs are **squash-only** (merge commits and rebase are disabled). The squashed commit on `trunk`
takes its subject from the **PR title**, so the PR title must follow the same
`type(scope): summary` convention — a `PR Title` CI check enforces this. Every `trunk` commit
therefore reads `type(scope): summary (#N)`.

## CI

Pull requests targeting `trunk` must pass a `Required Checks` gate before they can merge.

**The job list lives in `.github/workflows/ci.yml`, not here.** An enumeration in prose drifts —
this one had already fallen behind by four jobs — and `required-checks.needs` is the only copy that
decides anything.
