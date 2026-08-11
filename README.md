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

The process reads deployment configuration from the environment:

| Variable                         | Requirement | Meaning                                                    |
| -------------------------------- | ----------- | ---------------------------------------------------------- |
| `DATABASE_URL`                   | required    | Restricted `fidy_runtime` PostgreSQL URL                   |
| `MIGRATION_DATABASE_URL`         | required    | Separately privileged PostgreSQL URL used only during boot |
| `WHATSAPP_BUSINESS_PORTFOLIO_ID` | required    | Trusted portfolio scope for WhatsApp BSUIDs                |
| `WHATSAPP_DELIVERY_MODE`         | optional    | `bsuid` (default) or explicit `sandbox-phone` delivery     |
| `PORT`                           | optional    | HTTP port, defaulting to `3000`                            |
| `FIDY_HTTP_HOST`                 | optional    | Bind host, defaulting to `0.0.0.0`                         |
| `APP_VERSION`                    | optional    | Version returned by `GET /health`                          |
| `RAILWAY_DEPLOYMENT_ID`          | Railway     | Health version fallback when `APP_VERSION` is absent       |
| `RAILWAY_GIT_COMMIT_SHA`         | Railway     | Full GitHub-triggered SHA used to derive the release       |
| `SENTRY_RELEASE`                 | optional    | Local/CI release override; production derives it from SHA  |
| `SENTRY_AUTH_TOKEN`              | pre-deploy  | Upload-only token carrying only Sentry's `org:ci` scope    |
| `SENTRY_ORG`                     | pre-deploy  | Sentry organization receiving the immutable release        |
| `SENTRY_PROJECT`                 | pre-deploy  | Production server project receiving debug-ID artifacts     |

```sh
docker compose up -d db     # local Postgres on :5433
export DATABASE_URL=postgres://fidy_runtime:fidy_runtime@localhost:5433/fidy
export MIGRATION_DATABASE_URL=postgres://fidy:fidy@localhost:5433/fidy
export WHATSAPP_BUSINESS_PORTFOLIO_ID=portfolio-local
# Use sandbox-phone only with a Kapso sandbox number; it cannot deliver to BSUID recipients.
export WHATSAPP_DELIVERY_MODE=bsuid
bun run dev                 # rotates a local-only fin_ bearer, prints it once, starts API
```

Build and run the monolith from its production Dockerfile:

```sh
docker compose up --build
curl http://localhost:3000/health
```

The process applies pending migrations before binding the HTTP server or launching the daily
AuditLogEntry retention worker. Retention runs at startup and removes only evidence strictly older
than 365 days. It serves the canonical API,
`/openapi.json`, the public `/health` route, and the SPA shell from `public/` in one Effect runtime.
Canonical operations remain protected by scoped `fin_` bearer authorization. Configure Kapso's
buffered message-event webhook at `POST /webhooks/kapso` and its exact Meta forwarding webhook at
`POST /webhooks/kapso/meta`; the latter handles authenticated `user_changed_user_id` events while
acknowledging unrelated raw Meta events. Both use the configured Kapso webhook secret.
`railway.json` configures Railway to build the Dockerfile, prepare the immutable Sentry release,
provision the restricted runtime login, and apply migrations before deploy, then gate deployments
on `/health`. Release preparation derives `fidy@` plus Railway's full Git commit SHA; an explicitly
provided `SENTRY_RELEASE` must match that derived value. It creates the release, uploads and validates
the image's already-injected debug-ID artifacts with bounded retries, and finalizes it before database
preparation. Repeating the same SHA is safe. The upload token must carry only Sentry's `org:ci` scope, and the uploader pins
`https://sentry.io/` rather than accepting an environment-provided credential destination. The image
removes the token, organization/project upload coordinates, and non-production DSN before the
application starts. Railway's bounded pre-deploy command duration, fixed retry count, sanitized
failure reason, and exit status are the observation boundary for this workflow; application
telemetry is intentionally unavailable because the command prepares Sentry before activation. The
PR production-image gate validates the built artifacts, source maps, runtime isolation, telemetry-off
startup, and public HTTP surface before merge. An operator may then enable production capture
separately at 100% errors and 10% root traces, record the activation, and review accepted, filtered,
discarded, and quota-consuming volume after 24 hours. The full privacy, compatibility, and
production-image gates are required again for every Sentry SDK upgrade or diagnostic contract change.
Runtime ingestion failures, 429 responses, exhausted quota, and flush timeouts remain non-fatal after
activation.

The running process retains the production DSN and code-validated environment, release, capture
switches, and trace rate. Both database URLs must resolve inside the production environment: the
runtime login is exactly `fidy_runtime`, while the migration login can own tables and provision the
fixed `fidy_runtime` and `fidy_gateway` roles.

A future browser build must use the same `fidy@<full-sha>` release, inject and upload its debug-ID
maps before activation, and remove maps from public output. This deployment does not add a browser
build or browser telemetry.

The transient `health-cron` Railway service is built from `deploy/health-cron/`. Every five minutes
it requests the public health endpoint from its environment-only `HEALTH_URL` and exits, making a
failed scheduled check visible without adding application logic or another long-running process.

#### Hosted agent CLI-REPL

The REPL is a channel adapter over the same `AgentService.handleTurn` seam used by future hosted
channels. It requires the canonical API to be running, PostgreSQL to be available, and an OpenAI API
key; the production adapter always selects `gpt-5.4-nano` through Effect AI's OpenAI integration.
The key is loaded as redacted configuration and is never a command argument.

```sh
bun run dev
# In another terminal:
export DATABASE_URL=postgres://fidy_runtime:fidy_runtime@localhost:5433/fidy
export MIGRATION_DATABASE_URL=postgres://fidy:fidy@localhost:5433/fidy
export WHATSAPP_BUSINESS_PORTFOLIO_ID=portfolio-local
export OPENAI_API_KEY='<set in your secret environment>'
export FIDY_REPL_PHONE_NUMBER=$(docker compose exec -T db psql -U fidy -d fidy -Atc \
  'select phone_number from whatsapp_identities order by verified_at limit 1')
export FIDY_REPL_BSUID=$(docker compose exec -T db psql -U fidy -d fidy -Atc \
  'select business_scoped_user_id from whatsapp_identities order by verified_at limit 1')
bun run agent:repl
```

`FIDY_REPL_PHONE_NUMBER` and `FIDY_REPL_BSUID` must be evidence from the same seeded association;
the REPL never derives one from the other. `FIDY_API_BASE_URL` optionally changes the canonical server address and defaults to
`http://127.0.0.1:3000`. The REPL creates a short-lived HostedAgentToken for each turn so every model
tool traverses normal HTTP validation, authorization, and AuditLogEntry attribution.

GitHub Actions runs `Checks` for pull requests and again for the resulting `trunk` commit;
`Required Checks` protects `trunk`. Production authority provisioning and migrations run in
Railway's pre-deploy phase, and the production-image CI gate checks the built image's public health,
OpenAPI, and SPA routes before merge. Canonical-domain routing remains an independent DNS check.

The hosting escape hatch is the same Dockerfile plus a standard PostgreSQL dump:

```sh
pg_dump "$MIGRATION_DATABASE_URL" --format=custom --file=fidy.dump
```

The development startup accepts only a local PostgreSQL URL, binds the API to loopback, applies
pending migrations, and upserts one stable User and WhatsAppIdentity. It rotates the hashed
all-scopes AgentToken grant to a cryptographically random bearer disclosed once on stdout.
`bun src/main.ts` starts without this seed path.

Copy [`.env.example`](./.env.example) when a complete local environment is useful. Fidy's stable
web, API, callback, and ingestion addresses come from the shared
[`externalEndpoints`](./src/shell/_shared/external-endpoints.ts) configuration; production values
and operational verification are documented in
[`docs/operations/external-endpoints.md`](./docs/operations/external-endpoints.md).

### Testing

Two tiers, and **the tier is decided by which tree the test is in**, not by a naming convention.

Tests under `src/core/` are pure — no server, no database, no Docker:

```sh
bun run test:core
```

Tests under `src/shell/` run at the **API seam**: canonical operations through the derived typed
client against the real handler stack and a real Postgres (`src/shell/testing/api-harness.ts`). They
run with [@effect/vitest](https://www.npmjs.com/package/@effect/vitest) under vitest on the Bun runtime
(`bun --bun vitest`), matching production — the seam serves over a Bun HTTP server. They need both database authorities:

```sh
docker compose up -d db
DATABASE_URL=postgres://fidy_runtime:fidy_runtime@localhost:5433/fidy \
MIGRATION_DATABASE_URL=postgres://fidy:fidy@localhost:5433/fidy \
WHATSAPP_BUSINESS_PORTFOLIO_ID=portfolio-test bun run test
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
  in terms of the source — "a core slice may cross to a sibling only through `reference.ts`" is one
  relational rule there. `bun run lint:deps` also runs positive and negative dependency probes.
- **Formatter:** [oxfmt](https://oxc.rs) — configured in `.oxfmtrc.json`.
- **Type checker:** TypeScript 7 native (`typescript@7`, `tsconfig.json`, strict), patched with
  the Effect language service via [`@effect/tsgo`](https://github.com/Effect-TS/tsgo): the
  `postinstall` script runs `effect-tsgo patch` on every `bun install` to swap the `tsc` binary
  for the Effect-aware build. Every Effect diagnostic is configured at `error` severity in
  `tsconfig.json`, and Effect diagnostics fail the typecheck exit code.
- **Git hooks:** [lefthook](https://lefthook.dev) — lint/format on staged files and a
  commit-message convention check.

### Common scripts

| Command                          | What it does                                                                            |
| -------------------------------- | --------------------------------------------------------------------------------------- |
| `bun run lint`                   | oxlint                                                                                  |
| `bun run lint:type-aware`        | oxlint with the type-aware rules                                                        |
| `bun run lint:suppressions`      | reject lint-suppression comments in first-party source                                  |
| `bun run lint:deps`              | module-graph rules and positive/negative probes                                         |
| `bun run lint:deps:probes`       | dependency import-boundary probes                                                       |
| `bun run lint:dependencies`      | pins behind the registry, and the install delay                                         |
| `bun run build:production`       | build preload, application, and production commands with external source maps/debug IDs |
| `bun run start:production`       | start the built preload and application entries                                         |
| `bun run format`                 | Format the repo with oxfmt                                                              |
| `bun run format:check`           | Verify formatting without writing                                                       |
| `bun run typecheck`              | `tsc --noEmit` (Effect-patched)                                                         |
| `bun run test`                   | `bun --bun vitest run` (needs both database URLs)                                       |
| `bun run test:acceptance`        | signed WhatsApp HTTP scenarios against a fresh PostgreSQL database                      |
| `bun run test:core`              | the pure core tier — no Docker, no database                                             |
| `bun run test:crap`              | CRAP-score gate (needs both database URLs)                                              |
| `bun run test:mutation`          | mutation-score gate over `src/core` (no database)                                       |
| `bun run check:production-image` | built-artifact, source-map, migration, authority, telemetry-off, and HTTP smoke check   |
| `bun run verify`                 | all rows above except `format`, `test:core`, `test:crap`, and `check:production-image`  |

### Quality gates

Four test-based gates run on every pull request, with mutation testing shifted right to a nightly
check on `trunk`. They cover the behavioural source listed in `source-scope.mjs` (tests, the
`src/shell/testing` harness, and `src/main.ts` are out of scope):

- **Total coverage** — `bun run test` fails if line coverage over `src/core` and
  `src/shell` drops below 90%.
- **Core coverage** — `bun run test:core` fails if line coverage over `src/core`
  alone drops below 90%.
- **CRAP score** — `bun run test:crap` fails if any function's [CRAP score](https://www.npmjs.com/package/crap4ts)
  exceeds 8 (high complexity + low coverage).
- **WhatsApp acceptance** — `bun run test:acceptance` enters through the public signed Kapso
  webhook, uses real PostgreSQL and application coordination, and substitutes only Kapso transport
  and language-model behavior. Scenario IDs are printed in the retained CI log. Acceptance-only
  Istanbul coverage has initial ratchet floors of 41.5% lines and 15.77% branches. Vitest raises
  the checked-in floors when coverage improves, and CI rejects an unrecorded increase or any later
  decrease.
- **Mutation score** — the nightly and manually dispatchable Mutation workflow runs
  `bun run test:mutation` against `trunk` and fails if a single mutant
  [Stryker](https://stryker-mutator.io) plants in `src/core` survives the core tests. The threshold
  remains 100, but its runtime no longer delays or blocks pull requests.

The WhatsApp acceptance inventory is independent from lower-seam test counts:

| Scenario | Release behavior                                                    | Status     |
| -------- | ------------------------------------------------------------------- | ---------- |
| `WA-A01` | A new sandbox caller receives the disclosure                        | Executable |
| `WA-A02` | Portfolio + BSUID, never phone evidence, authorizes the caller      | Executable |
| `WA-A03` | Missing sandbox phone evidence fails closed without a provider call | Executable |
| `WA-A04` | Consent acceptance establishes the stable User                      | Executable |
| `WA-A05` | A financial message creates one Transaction and visible reply       | Executable |
| `WA-A06` | Duplicate webhooks do not duplicate effects                         | Executable |
| `WA-A07` | Definitive provider rejection becomes safely retryable              | Executable |
| `WA-A08` | Ambiguous delivery is not automatically replayed                    | Executable |
| `WA-A09` | Missing lifecycle webhook leaves delivery durably ambiguous         | Executable |
| `WA-A10` | Normal delivery uses only `recipient`; sandbox uses only `to`       | Executable |

The acceptance command requires `DATABASE_URL` and `MIGRATION_DATABASE_URL` for a fresh database
whose restricted runtime role has been installed with `deploy/local-postgres-init.sql`.

`bun run verify` runs total coverage and mutation testing locally, not the acceptance,
core-coverage, or CRAP commands, so a clean `verify` is still not a clean pull-request run.

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
`src/core/transactions/model.test.ts` covers by hand.

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
slice, because a slice's pure half and its impure half change together:

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
| `transcript`   | transcript, rolling summary, user notes          |
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
— but code lands in them, so they need a scope.

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
