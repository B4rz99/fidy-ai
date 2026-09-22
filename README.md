# Fidy

Fidy is an agent-first personal finance product for Colombia. Users manage their finances through
WhatsApp, and their own agents use the same canonical API as Fidy's hosted agent.

The project is under development. Cloudflare is the production platform; the server package currently
provides domain, contract, and provider-boundary code while Cloudflare adapters are added.

## Run locally

Requirements: [Bun](https://bun.sh), [Gitleaks](https://github.com/gitleaks/gitleaks), and
[TruffleHog](https://github.com/trufflesecurity/trufflehog). Secret scans run in the pre-push hook.

```sh
bun install
cp .env.example .env
bun run dev
```

Alchemy starts the browser at <http://localhost:5173>, public ingress at
<http://127.0.0.1:8787>, and private Core at <http://127.0.0.1:8788> with the Production
service-binding graph. `bun run dev:web` remains available for isolated UI work, but it does not prove
the Cloudflare boundary. The built static artifact can be checked with:

```sh
bun run --cwd apps/web build:preview
bun run --cwd apps/web test:browser
```

## Tests and checks

```sh
bun run test:core
bun run test
bun run verify
```

See [`.env.example`](./.env.example) for retained local configuration and the project documentation:

- [Domain context](./CONTEXT.md)
- [System architecture](./ARCHITECTURE.md)
- [Server architecture](./apps/server/ARCHITECTURE.md)
- [Web architecture](./apps/web/ARCHITECTURE.md)
- [Coding standards](./CODING_STANDARDS.md)

## Commit messages

Use `type(scope): #123 summary` followed by one or more `-` body bullets. The `#123` immediately after
the colon is the originating GitHub issue reference; use `- Fixes #123` in the body or PR description
when merging should close the issue.

Allowed types:

<!-- commit-types -->

`feat` · `fix` · `refactor` · `chore` · `docs` · `test` · `ci`

Slice scopes:

<!-- commit-scopes:slices -->

| scope          | when to use                           |
| -------------- | ------------------------------------- |
| `identity`     | users, channel identities, sessions   |
| `consent`      | consent records and revocations       |
| `transactions` | the ledger and reconciliation         |
| `categories`   | spending categories and keyword rules |
| `budgets`      | monthly caps and alerts               |
| `recurring`    | recurring series                      |
| `dashboard`    | dashboard read model                  |
| `insights`     | insight events                        |
| `ingestion`    | capture and review                    |
| `tokens`       | PATs and scopes                       |
| `audit`        | the audit trail                       |
| `transcript`   | transcript and user notes             |
| `billing`      | subscriptions and payments            |

Cross-cutting scopes:

<!-- commit-scopes:cross-cutting -->

| scope        | when to use                                |
| ------------ | ------------------------------------------ |
| `api`        | API assembly, transport, and authorization |
| `channels`   | vendor adapters and callbacks              |
| `agent`      | hosted agent and its harness               |
| `frontend`   | web app                                    |
| `cloudflare` | Worker, D1, DO, Queue, Workflow, R2, or AI |
| `repo`       | tooling, configuration, hooks, and CI      |
| `deps`       | dependency updates                         |
| `docs`       | documentation                              |
