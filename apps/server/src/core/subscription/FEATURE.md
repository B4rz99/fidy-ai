# Subscriptions and access tiers

Subscriptions grant paid Pro access after independently verified settlement. AccessTier is
derived for each decision from the original TrialPeriod, a settled paid period, or eligible
three-day renewal grace. It is never a separately stored entitlement. PaymentSource approval
alone does not grant Pro. Quota exhaustion is distinct from a Paywall.

| Functionality                               | Local verification                                                                                                                                            | Production verification, 2026-10-14                                                              |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| Offers, upgrade guidance and billing status | Complete immutable weekly/monthly/yearly COP offers; bounded same-User history; expired/revoked/under-scoped credentials                                      | Anonymous reads return 401 and `no-store`; signed-in offers/status return 200 (2026-10-15)       |
| Trial and AccessTier                        | Half-open trial/paid/grace boundaries, User isolation, immutable original trial, refund adjustments and independent trial preservation                        | Boundary manipulation not induced on real accounts                                               |
| Browser-only payment enrollment             | Origin, fresh session, Consent, terms, admission, expiry, duplicate submissions and ambiguous provider outcomes; PAT/agent exclusion                          | Availability rejects foreign Origin with 403 and missing session with 401; no enrollment started |
| Card, Nequi and DaviPlata                   | Controlled provider responses; first card and DaviPlata browser → public Ingress → private Core/local D1 journeys; reused-source enrollment                   | Actual provider protocol remains separate; see proof runbooks below                              |
| Collection and settlement                   | D1 outbox, Queue redelivery, Workflow claims, signed callback verification, matching provider lookup, concurrency and one paid period per verified success    | Deployed provider callbacks and real settlement not exercised                                    |
| Renewals                                    | Weekly/monthly/yearly calendar anchors, month-end/leap-day clamps, frozen Money/Price, bounded 24/48-hour retries and three-day grace                         | Scheduled deployed collection not exercised                                                      |
| Cancellation                                | Live write authority, atomic Audit, durable stop, queued-charge fencing, preserved paid history, bounded DaviPlata source-void reconciliation                 | No existing subscription cancelled                                                               |
| Price changes                               | Immediate durable notice and frozen existing attempts; new Price applies to newly admitted work                                                               | Live billing-email delivery not exercised                                                        |
| Refunds                                     | Separate support authority, exact Money, competing reservations, single financial submission, reconciliation, immutable charge history and trial preservation | Real-money execution deliberately excluded                                                       |
| Free allowances                             | Shared admission/replay, exhaustion and tier-aware accounting; Free remains distinct from resource protection                                                 | Quota exhaustion not deliberately induced                                                        |

## Evidence and reruns

Local audit revision: `5d3cda1f4962b103cf3f916b6c81c36ed1540262`. These Subscription,
AccessTier and enrollment source directories initially matched deployed revision
`20889fa3d90d8f86c09ddce0cc790c8bb6ac761c`. The subsequent optional-email enrollment fix
has local evidence only until deployed and rerun.

Passed: **329 Subscription Worker/D1/provider-adapter checks**, **1 AccessTier D1 check**,
**7 shell Subscription checks**, **17 canonical-admission checks**, **21 web Subscription
checks**, **3 real-Core browser journeys**, and **2 browser presentation journeys**.
The **53 statement-ingestion Worker/D1 checks** also passed, including Free backfill reservation,
Paywall refusal and release after zero-capture expiry.
The full Core suite also passed **421 checks**, including Subscription decisions. Counts overlap
in scope; they are not a claim of exhaustive Production coverage. Local external payment and
identity responses are controlled fixtures; D1 and public/Core execution are real local adapters.

```sh
bun run --cwd apps/server test:core
bun run --cwd apps/server test:cloudflare cloudflare/subscription --maxWorkers=1
bun run --cwd apps/server test:cloudflare cloudflare/access-tier.test.ts cloudflare/canonical-admission/operations.test.ts --maxWorkers=1
bun run --cwd apps/server test:cloudflare cloudflare/ingestion/statement-ingestion.test.ts --maxWorkers=1
bun run --cwd apps/server test src/shell/subscription --coverage.enabled=false
bun run --cwd apps/web test src/features/subscription
bun run --cwd apps/web test:browser e2e/01-real-core-journeys.spec.ts --grep 'Subscription|first card|DaviPlata' --workers=1
bun run --cwd apps/web test:browser e2e/product-journeys.spec.ts --workers=1
```

Eight opt-in real-provider cases are skipped by the ordinary local suite: four Nequi and four
DaviPlata Sandbox scenarios. Only the four Nequi cases have separate passing live-provider evidence. The protected
[Nequi Sandbox proof](../../../../../docs/operations/nequi-sandbox-proof.md) and
[DaviPlata Sandbox proof](../../../../../docs/operations/daviplata-sandbox-proof.md) document
synthetic-only provider execution. DaviPlata's reviewed OTP send/confirm variables are absent
from the protected Production environment at this audit; do not guess destinations or enable it.

The [Nequi Sandbox run](https://github.com/B4rz99/fidy-ai/actions/runs/38672345124) passed all four
selected cases on deployed trunk revision `20889fa3d90d8f86c09ddce0cc790c8bb6ac761c`, completed
2026-10-14 at 21:49 Bogotá. Weekly/monthly/yearly first payments reached independently verified
success; declined weekly payment reached the bounded failure decision. This is real provider
Sandbox evidence with local D1/activity execution, not deployed callback or Workflow proof.

On 2026-10-15, the deployed browser received session binding, offers and status responses of 200,
but enrollment availability returned 401 (trace `496f23800cdd3df399e3e9b20b200447`).
The enrollment authority incorrectly required the optional verified email-login credential.
Local regressions reproduce that refusal and verify availability, explicit billing contact,
editable prefilled billing email, first-card settlement and retained-source contact reuse without that credential. The built-browser
regression failed with the original join and passed with the fix against public Ingress/Core/local
D1 and controlled Wompi responses. Fresh-session and active-Consent guards remain required.

Remaining safe live work: deploy and verify the optional-email fix; DaviPlata
Sandbox protocol proof; and isolated deployed Queue/Workflow/callback recovery evidence before
claiming the entire payment lifecycle is verified. Real charges, live refunds, recurring debit
authorization and changing existing subscriptions are excluded from this audit.

Owners: [Core decisions](operations.ts), [canonical API](../../shell/subscription/contract.ts),
[native billing](../../../cloudflare/subscription/operations.ts),
[AccessTier guard](../../shell/access-tier/operations.ts), and
[commercial allowances](../../../../../docs/operations/commercial-allowances.md).
