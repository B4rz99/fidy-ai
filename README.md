# Fidy

Fidy is an agent-first personal finance product for Colombia. Users manage their finances through
WhatsApp, and their own agents use the same API as Fidy's hosted agent.

The project is under development.

## Run locally

Requirements: [Bun](https://bun.sh) and [Docker](https://www.docker.com/).

```sh
bun install
cp .env.example .env
# Set WHATSAPP_BUSINESS_PORTFOLIO_ID=portfolio-local in .env.
docker compose up -d db
bun run dev
```

The API is available at <http://localhost:3000>; health checks are at
<http://localhost:3000/health>.

To run the complete application in Docker instead:

```sh
docker compose up --build
```

## Tests

```sh
bun run test:core  # pure core tests; no database required
bun run test       # full suite; requires the local PostgreSQL configuration
```

See [`.env.example`](./.env.example) for configuration and the project documentation for more
context:

- [Domain context](./CONTEXT.md)
- [Architecture](./ARCHITECTURE.md)
- [Coding standards](./CODING_STANDARDS.md)

## Commit messages

Use `type(scope): summary` followed by one or more `-` body bullets.

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
| `tokens`       | agent tokens and scopes               |
| `audit`        | the audit trail                       |
| `transcript`   | transcript and user notes             |
| `billing`      | subscriptions and payments            |

Cross-cutting scopes:

<!-- commit-scopes:cross-cutting -->

| scope      | when to use                                |
| ---------- | ------------------------------------------ |
| `api`      | API assembly, transport, and authorization |
| `channels` | vendor adapters and callbacks              |
| `agent`    | hosted agent and its harness               |
| `frontend` | web app                                    |
| `db`       | schema, migrations, and SQL                |
| `repo`     | tooling, configuration, hooks, and CI      |
| `deps`     | dependency updates                         |
| `docs`     | documentation                              |
