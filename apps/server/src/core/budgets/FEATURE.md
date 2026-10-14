# Budgets

One User-owned monthly cap for one Category and Currency. Budgets are managed through
canonical operations (API, CLI and agents); there is no dedicated Budget management view.
The Dashboard has a read-only Budget Widget.

| Functionality                                              | Local verification                                                                                                         | Production verification, 2026-10-12                                                    |
| ---------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| Create, list, read, revise and delete                      | Actual Worker/D1 CRUD and atomic rollback                                                                                  | Disposable Restaurant/COP Budget created, listed, read, revised and deleted            |
| Positive cap, unique Category/Currency, immutable Currency | Validation and duplicate cases                                                                                             | Duplicate create and Currency change refused; retained cap verified                    |
| Exact monthly spending and status                          | Under/reached/over, decimal precision, half-open IANA month, outflows only, Category/Currency filters                      | 80 COP against caps 100/80/70 returned 20 remaining/reached/10 over; 900 USD excluded  |
| Ownership and access                                       | Foreign User and under-scoped PAT refusals; no disclosure or mutation                                                      | Not induced with real accounts                                                         |
| Threshold alerts                                           | 80%/100% latch once, frozen crossing facts, backdated months, correction/concurrency, rollback and repair                  | Real proactive delivery not verified                                                   |
| Alert delivery and Consent                                 | Separate category grants, decline/revoke/replay, frozen intent, Queue/Workflow redelivery and verified callback settlement | Blocked: available Kapso endpoint is sandbox; templates require a connected number     |
| Capacity and unavailable state                             | More than 5,000 movements, shared admission limits and corrupt retained state                                              | Capacity/failure conditions not induced                                                |
| Dashboard Budget Widget                                    | Rendered checks plus built browser → Ingress → Core/local D1 reload journey                                                | Under/reached/over and missing Budget survived full reload; currencies stayed separate |

## Evidence and reruns

The 2026-10-12 rerun passed **16 Core Budget checks**, **33 Worker/D1 Budget checks**,
**38 Dashboard rendering/Money checks**, **71 Worker/D1 Dashboard checks**, and **1 real
built-browser Budget lifecycle check**. New regressions cover combined Category/Currency
filters and the persisted Widget lifecycle. External identity responses are substituted in
the local browser fixture; Budget operations, admission and persistence are real.

The alert rerun additionally passed **28 Worker/D1 opt-in and delivery checks**, **35 Core
Insights checks**, and **30 WhatsApp transport checks**. These cover independent category
grants, undisclosed/foreign/replayed choices, decline and revocation, expiry, quiet hours,
provider rejection/ambiguity, and exact authenticated delivery callbacks. Provider acceptance
alone does not count as delivery; provider responses in these checks are fixtures.

```sh
bun run --cwd apps/server test:core src/core/budgets --coverage.enabled=false
bun run --cwd apps/server test:cloudflare cloudflare/budgets --maxWorkers=1
bun run --cwd apps/web test src/features/dashboard/feature.test.tsx src/features/dashboard/money-presentation.test.ts src/features/dashboard/presentation.test.ts
bun run --cwd apps/server test:cloudflare cloudflare/dashboard --maxWorkers=1
bun run --cwd apps/web test:browser budget-widget.spec.ts --workers=1 --timeout=120000
bun run --cwd apps/server test:cloudflare cloudflare/consent/proactivity-consent.test.ts cloudflare/agent/proactivity-choice.test.ts cloudflare/insights/proactivity-runtime.test.ts --maxWorkers=1
bun run --cwd apps/server test:core src/core/insights --coverage.enabled=false
bun run --cwd apps/server test:whatsapp
```

Live checks used release `6863b80f2a5eda38db8c870468e823fb2387829a` and an explicitly
approved seven-day `read`/`write`/`dashboard` PAT. The account began with no Budgets or
Transactions. Only one Budget and two labelled Transaction fixtures were added, then
removed through canonical operations. Empty Budget/Transaction lists and the original
Dashboard projection were verified afterward; browser reload restored all four empty
Widgets. No browser warnings or errors were observed. Local QA credentials were removed.

The Widget belongs to [Dashboard](../../../../web/src/features/dashboard/FEATURE.md).
Live proactive WhatsApp alerts and opt-in remain unverified. The available Kapso number is a
sandbox endpoint; [Kapso explicitly excludes template sends from its sandbox](https://kapso.com/whatsapp-api-sandbox).
The alert sender uses approved templates and BSUID addressing. Production composition previously
omitted `PROACTIVITY_ENABLED` and `PROACTIVITY_TEMPLATE_JSON`; this change wires both through
the protected deployment, defaulting to disabled/empty. This is configuration preparation,
not Production enablement or provider approval.

Remaining live checks require a connected number, its approved `Fidy: {{1}}` template and
matching language, a linked test recipient, and an open 09:00–19:00 local delivery window.
Verify the disclosed opt-in/decline/revoke journey, fresh 80% and 100% crossings, exactly one
visible alert each, and authenticated delivery settlement. Restore only disposable fixtures.
