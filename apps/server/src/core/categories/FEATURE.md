# Categories and categorization rules

Sixteen shared Colombian Categories with stable identities. Each User can retain up to
100 counterparty keyword rules through canonical API, CLI and agent operations. There is
no dedicated rule management view; Transactions use Category labels for filtering and correction.

| Functionality                          | Local verification                                                                                                                                      | Production verification, 2026-10-13                                                              |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| Discover Categories                    | Stable identities, presentation order, malformed storage and live caller checks; built-browser rendering through real Ingress/Core/D1                   | All 16 Categories returned in order through the native CLI                                       |
| Create, list, replace and delete rules | User-owned CRUD, retained identity, replacement at capacity and reuse after deletion                                                                    | Native CLI CRUD passed; disposable rules removed and original baseline restored                  |
| Match future captures                  | Explicit Category wins; case/accent-insensitive counterparty substring, longest keyword, stable-id tie, then Ingresos/Otros direction fallback          | Case/accent normalization, longest keyword, explicit Category and direction fallbacks passed     |
| Preserve history and refused edits     | Earlier Transactions stay unchanged after replacement/deletion; conflicting and unknown-Category edits preserve the original rule and matching behavior | Replacement/deletion changed future captures only; refused edits preserved the rule              |
| Validation and capacity                | Trimmed nonempty keyword up to 80 characters, normalized duplicates, 100-rule limit, concurrent duplicate creates retain one winner                     | Normalized duplicate and unknown-Category refusals passed; capacity/concurrency not induced live |
| Authority and atomicity                | Foreign User, read-only PAT, revoked session, browser Origin, Audit rollback, mixed-owner batch conflicts/capacity and OAuth destructive review         | Approved read/write grant admitted mutations; isolation/atomicity negatives remain local         |

## Evidence and reruns

The rerun passed **5 Core checks**, **153 Worker/D1 checks** and **1 built-browser check**.
Two native OAuth host checks were skipped because their external host bridge was not configured;
the local OAuth confirmation checks ran. The browser fixture substitutes external identity
responses; Category operations, admission and persistence are real.

New regressions exercise public Category/rule and Transaction operations against actual
local D1. They verify future capture after replacement, unchanged rules after refused edits,
concurrent normalized duplicates, and reuse of a deleted capacity slot. Responses decode through
the owning public schemas. No Category behavior changed to make these cases pass.

```sh
bun run --cwd apps/server test:core src/core/categories --coverage.enabled=false
bun run --cwd apps/server test:cloudflare cloudflare/categories cloudflare/transactions/transactions.test.ts cloudflare/canonical-admission/operations.test.ts cloudflare/oauth-agents/oauth-confirmation.test.ts --maxWorkers=1
bun run --cwd apps/web test:browser 01-real-core-journeys.spec.ts --grep 'renders a seeded Category identity' --workers=1 --timeout=120000
```

Production checks used release `a539302ef269a3ca1b4cfc78615a917b960c7c48`. The native CLI
read all 16 Categories, created general/specific rules, captured seven synthetic Transactions,
verified explicit precedence and rejected duplicates/unknown Categories, replaced/deleted rules,
and checked future capture plus unchanged history. Cleanup restored the exact original rule and
Transaction lists. After fresh sign-in to the owning account, the temporary Category QA grant
was revoked in Production. A subsequent native CLI read returned `unauthenticated`, and its
isolated local credential was removed.

The live journey exposed stale CLI approval and management links after the marketing/application
host split. These now use `app.fidyapp.com`; the existing command regression failed before the
fix, and all **98 CLI checks** passed afterward.

Category correction and filtering belong to
[Transactions](../../../../web/src/features/transactions/FEATURE.md). Hosted model interpretation is a separate boundary;
the deterministic matching checks here do not prove real model accuracy or WhatsApp delivery.
