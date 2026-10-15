# Subscriptions and access tiers

Subscriptions grant paid Pro access after independently verified settlement. AccessTier is
derived for each decision from the original TrialPeriod, a settled paid period, or eligible
three-day renewal grace. It is never a separately stored entitlement. PaymentSource approval
alone does not grant Pro. Quota exhaustion is distinct from a Paywall.

| Functionality                               | Local verification                                                                                                                                            | Production verification, 2026-10-15                                                                 |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| Offers, upgrade guidance and billing status | Complete immutable weekly/monthly/yearly COP offers; bounded same-User history; expired/revoked/under-scoped credentials                                      | Anonymous reads return 401 and `no-store`; signed-in offers/status return 200 (2026-10-15)          |
| Trial and AccessTier                        | Half-open trial/paid/grace boundaries, User isolation, immutable original trial, refund adjustments and independent trial preservation                        | Boundary manipulation not induced on real accounts                                                  |
| Browser-only payment enrollment             | Origin, fresh session, Consent, terms, admission, expiry, duplicate submissions and ambiguous provider outcomes; PAT/agent exclusion                          | Origin/session refusals; fresh provider-only account prepared and submitted synthetic card payment  |
| Card, Nequi and DaviPlata                   | Controlled provider responses; first card and DaviPlata browser → public Ingress → private Core/local D1 journeys; reused-source enrollment                   | Actual provider protocol remains separate; see proof runbooks below                                 |
| Collection and settlement                   | D1 outbox, Queue redelivery, Workflow claims, signed callback verification, matching provider lookup, concurrency and one paid period per verified success    | Deployed Queue/Workflow and authenticated lookup verified synthetic card decline; zero paid periods |
| Renewals                                    | Weekly/monthly/yearly calendar anchors, month-end/leap-day clamps, frozen Money/Price, bounded 24/48-hour retries and three-day grace                         | Scheduled deployed collection not exercised                                                         |
| Cancellation                                | Live write authority, atomic Audit, durable stop, queued-charge fencing, preserved paid history, bounded DaviPlata source-void reconciliation                 | No existing subscription cancelled                                                                  |
| Price changes                               | Immediate durable notice and frozen existing attempts; new Price applies to newly admitted work                                                               | Live billing-email delivery not exercised                                                           |
| Refunds                                     | Separate support authority, exact Money, competing reservations, single financial submission, reconciliation, immutable charge history and trial preservation | Real-money execution deliberately excluded                                                          |
| Free allowances                             | Shared admission/replay, exhaustion and tier-aware accounting; Free remains distinct from resource protection                                                 | Quota exhaustion not deliberately induced                                                           |

## Evidence and reruns

Local audit revision: `5d3cda1f4962b103cf3f916b6c81c36ed1540262`. These Subscription,
AccessTier and enrollment source directories initially matched deployed revision
`20889fa3d90d8f86c09ddce0cc790c8bb6ac761c`. The optional-email enrollment fix was merged in
[PR #1324](https://github.com/B4rz99/fidy-ai/pull/1324) and
[deployed successfully](https://github.com/B4rz99/fidy-ai/actions/runs/38780574628) at revision
`3e184387cd7e8a5772cca4c868be48ffa7b0f825` on 2026-10-15. Public health confirms that revision.
Post-deployment unauthenticated offers/status/enrollment return 401 with `no-store`;
foreign-Origin enrollment returns 403 with `no-store`. After fresh Google sign-in, authenticated
offers/status/availability and weekly/monthly card preparation returned 200. The provider-only
account reached the payment form with an empty billing-email field and a Sandbox public key.
Availability trace: `a9943b75a69b15bb2f0904b62cbe74cb`; weekly preparation trace:
`a4b2368cce400de0e0574a83d956cbfa`. No payment was submitted for those preparation checks.

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
DaviPlata Sandbox scenarios. Both providers have separate passing four-case live-provider evidence. The protected
[Nequi Sandbox proof](../../../../../docs/operations/nequi-sandbox-proof.md) and
[DaviPlata Sandbox proof](../../../../../docs/operations/daviplata-sandbox-proof.md) document
synthetic-only provider execution. After the passing DaviPlata proof, the two protected OTP variables were set to the exact Sandbox
endpoint; release now forwards them. Real-payment activation remains disabled. Manual synthetic tokenization on 2026-10-15 established the
exact Sandbox host/path and identity/operation query binding. The adapter and browser CSP now
support that observed protocol, with 22 closed Outbound HTTP checks, 52 browser transport/Subscription
checks, and a passing isolated built-browser DaviPlata collection journey plus served-CSP check.
Provider responses in that browser journey are controlled. A protected diagnostic run isolated an
OTP-send refusal caused by rejecting the observed `daviplata_test_` Sandbox identity prefix. Local
regressions cover the corrected prefix across outbound transport, browser and Core/local D1 enrollment.
The [protected DaviPlata run](https://github.com/B4rz99/fidy-ai/actions/runs/38793956290) at
`90c912702f3a4286d66fae29a4eaa78aa5cbfefa` passed all four cases: real OTP authorization,
reusable-source verification, weekly/monthly/yearly approved first payments and declined weekly
settlement with no paid period. This uses real Wompi Sandbox with local D1/activity execution.
Actual deployed browser OTP CORS, Queue/Workflow and recovery remain separate live checks. Production-mode DaviPlata activation is separate.

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

A later approved synthetic card submission on that deployed revision returned 200 after Sandbox
tokenization returned 201. Wompi’s documented decline card reached authenticated `DECLINED`
evidence. The deployed BillingCollection Workflow completed, and scheduled reconciliation marked
the attempt failed after its three-minute verification window. Bounded indexed D1 reads confirmed
zero paid periods, current Subscriptions and follow-up messages for the attempt. The browser showed
Wompi’s refusal. Submission trace: `e03d240a14de5e15f46412524daa73c7`. No real money was charged.

This exposed two remaining retry gaps: terminal browser submission disables all offer/method choices
without a retry action, and preparation always reuses a retained card source. A failed first payment
has no paid Subscription eligible for canonical cancellation, so that path cannot release the source
for a different card. Successful deployed card payment and cancellation remain unverified.

Remaining safe live work: close declined-source replacement/retry; complete an approved synthetic
deployed payment and cancellation; complete deployed DaviPlata browser/CORS checks;
and isolated deployed Queue/Workflow/callback recovery evidence before
claiming the entire payment lifecycle is verified. Real charges, live refunds, recurring debit
authorization and changing existing subscriptions are excluded from this audit.

The subsequent Upgrade regression checks cookie-only Processing Consent before mounting ordinary
Subscription queries or enrollment controls. A withdrawn User sees the withdrawal and a Privacy
link instead of a sign-in prompt, including after reload; no Subscription/payment requests are
sent. A failed Consent check stays closed and can be retried; a browser without a session still
gets sign-in guidance. Production payment testing on the second QA account is blocked by its
withdrawn Consent. Explicit Processing Consent renewal is implemented in Privacy and verified locally;
returning login and repeated signup still preserve withdrawal. Live renewal and the approved Sandbox
payment/cancellation await deployment recovery. No historical withdrawal or grant was edited to unblock testing.

Owners: [Core decisions](operations.ts), [canonical API](../../shell/subscription/contract.ts),
[native billing](../../../cloudflare/subscription/operations.ts),
[AccessTier guard](../../shell/access-tier/operations.ts), and
[commercial allowances](../../../../../docs/operations/commercial-allowances.md).
