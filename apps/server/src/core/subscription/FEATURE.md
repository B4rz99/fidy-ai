# Subscriptions and access tiers

Subscriptions grant paid Pro access after independently verified settlement. AccessTier is
derived for each decision from the original TrialPeriod, a settled paid period, or eligible
three-day renewal grace. It is never a separately stored entitlement. PaymentSource approval
alone does not grant Pro. Quota exhaustion is distinct from a Paywall.

| Functionality                               | Local verification                                                                                                                                                     | Production verification, 2026-10-15                                                                  |
| ------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| Offers, upgrade guidance and billing status | Complete immutable weekly/monthly/yearly COP offers; bounded same-User history; expired/revoked/under-scoped credentials                                               | Anonymous reads return 401 and `no-store`; signed-in offers/status return 200 (2026-10-15)           |
| Trial and AccessTier                        | Half-open trial/paid/grace boundaries, User isolation, immutable original trial, refund adjustments and independent trial preservation                                 | Boundary manipulation not induced on real accounts                                                   |
| Browser-only payment enrollment             | Origin, fresh session, Consent, terms, admission, expiry, duplicate submissions and ambiguous provider outcomes; PAT/agent exclusion                                   | Origin/session refusals; fresh provider-only account prepared and submitted synthetic card payment   |
| Card, Nequi and DaviPlata                   | Controlled provider responses; first card and DaviPlata browser → public Ingress → private Core/local D1 journeys; reused-source enrollment                            | Actual provider protocol remains separate; see proof runbooks below                                  |
| Collection and settlement                   | D1 outbox, Queue redelivery, Workflow claims, signed callback verification, matching provider lookup, concurrency and one paid period per verified success             | Synthetic card decline preserved zero paid periods; approved weekly card created one paid period     |
| Renewals                                    | Weekly/monthly/yearly calendar anchors, month-end/leap-day clamps, frozen Money/Price, bounded 24/48-hour retries and three-day grace                                  | Scheduled deployed collection not exercised                                                          |
| Cancellation                                | Live write authority, atomic Audit, durable stop, queued-charge fencing, preserved paid history, bounded DaviPlata source-void reconciliation; HTTP → User coordinator | Deployed Sandbox card cancellation and identical retry passed; paid period retained, source detached |
| Price changes                               | Immediate durable notice and frozen existing attempts; new Price applies to newly admitted work                                                                        | Live billing-email delivery not exercised                                                            |
| Refunds                                     | Separate support authority, exact Money, competing reservations, single financial submission, reconciliation, immutable charge history and trial preservation          | Real-money execution deliberately excluded                                                           |
| Free allowances                             | Shared admission/replay, exhaustion and tier-aware accounting; Free remains distinct from resource protection                                                          | Quota exhaustion not deliberately induced                                                            |

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
for a different card. A successful deployed card payment and cancellation were subsequently verified
on the other approved QA account, as detailed below.

Remaining safe live work: verify the declined-card retry/replacement fix after deployment; complete deployed DaviPlata browser/CORS checks;
and isolated deployed Queue/Workflow/callback recovery evidence before
claiming the entire payment lifecycle is verified. Real charges, live refunds, recurring debit
authorization and changing existing subscriptions are excluded from this audit.

The subsequent Upgrade regression checks cookie-only Processing Consent before mounting ordinary
Subscription queries or enrollment controls. A withdrawn User sees the withdrawal and a Privacy
link instead of a sign-in prompt, including after reload; no Subscription/payment requests are
sent. A failed Consent check stays closed and can be retried; a browser without a session still
gets sign-in guidance. The deployed withdrawn-Consent message and explicit renewal passed on
2026-10-15 at revision `4dfc547ab40e47b50c00fde800d3236fe550239f`, following
[successful deployment](https://github.com/B4rz99/fidy-ai/actions/runs/38815398101).
Returning login preserved withdrawal; explicit approved renewal returned active authorization,
survived reload and allowed enrollment. No historical withdrawal or grant was edited to unblock testing.

The approved deployed weekly card payment then passed with a Sandbox-only public key and Wompi's
synthetic approval card. Sandbox tokenization returned 201 and Fidy submission returned 200. The
browser reported an active Subscription; a subsequent canonical status read independently showed
a succeeded attempt and persisted weekly COP 9,900 paid period through `2026-10-22T23:14:33.000Z`.
This exercises the deployed first-payment path, rather than inferring settlement from the existing
TrialPeriod. No real money was charged.

The live cancellation call returned canonical `unavailable` (trace
`1132b246dd9f70d2d484d7393b9afd99`); an indexed read confirmed no cancellation committed.
The operation was installed in the canonical mutation registry but absent from Core's HTTP
dispatcher. The added HTTP → real User coordinator/local D1 regression returned 503 without the
dispatcher branch and 200 with it, retaining the original paid-through value. The focused renewal
and Subscription query suites passed 100 checks, including write-scoped PAT cancellation.

[PR #1334](https://github.com/B4rz99/fidy-ai/pull/1334) shipped the dispatcher fix in
[deployment 38834275954](https://github.com/B4rz99/fidy-ai/actions/runs/38834275954) at revision
`5d3db388ee7694f69d7469cfc00dadeda3170fd9`. The approved Sandbox cancellation then returned
`detached`; a second call returned the identical cancellation instant and paid-through value.
Canonical status still returned Pro, the original paid Subscription through
`2026-10-22T23:14:33.000Z`, and the succeeded attempt. An indexed read independently confirmed
one paid period, the durable cancellation, zero armed collections and zero follow-up messages
(four rows read, zero written). All 332 local billing checks passed; eight opt-in provider cases
were skipped by this rerun. After fresh browser sign-in, the temporary Subscription QA grant was
revoked; a subsequent canonical request returned unauthenticated. Its isolated native credential
and metadata were cleared; the pre-existing CLI credential was preserved.

Local follow-up: rendered-browser regressions cover explicit retry, replacement after reload, and a new card form with
unselected provider terms and no automatic second submission. Native Core/local D1 regressions
cover known verified decline, pending payment, paid Subscription, provider error and lost creation
response. The latter four cannot retire a source. Rejected replacement preserves the original
prepared enrollment atomically. New card sources retain the original failed attempt and source
identity; only one source is active. Historical attempts without retained creation-response evidence
remain blocked pending attributable no-charge confirmation. These are local results; deployed
verification remains pending.
Both retry paths also complete controlled-provider settlement with the original failed attempt
retained and exactly one paid period. A populated forward-migration check preserves existing
source identities, BillingAttempts, outbox, collection arms and foreign keys. After integrating
Titular erasure, full-chain checks also verify source fences, exact-User receipt disposition,
finite-hold archives and removal ordering; retirement history remains in retained billing records.

Owners: [Core decisions](operations.ts), [canonical API](../../shell/subscription/contract.ts),
[native billing](../../../cloudflare/subscription/operations.ts),
[AccessTier guard](../../shell/access-tier/operations.ts), and
[commercial allowances](../../../../../docs/operations/commercial-allowances.md).
