# Subscriptions and access tiers

Subscriptions grant paid Pro access after independently verified settlement. AccessTier is
derived for each decision from the original TrialPeriod, a settled paid period, or eligible
three-day renewal grace. It is never a separately stored entitlement. PaymentSource approval
alone does not grant Pro. Quota exhaustion is distinct from a Paywall.

| Functionality                               | Local verification                                                                                                                                                     | Production verification, through 2026-10-16                                                          |
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

At that point, remaining safe live work included deployed declined-card retry/replacement (subsequently passed below), successful DaviPlata browser OTP authorization,
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

On 2026-10-16 UTC, both real-provider Sandbox proofs were rerun at merged revision
`dc0c7d01ff802ed123adfebd2501542c3502d517`: [Nequi run 38849853307](https://github.com/B4rz99/fidy-ai/actions/runs/38849853307)
and [DaviPlata run 38849855435](https://github.com/B4rz99/fidy-ai/actions/runs/38849855435)
each passed their four selected cases: weekly/monthly/yearly approval and weekly decline.
These proofs use actual Sandbox provider protocols with local D1/activity execution, not the
deployed browser, callback, Queue or Workflow. No real charges were made.

The retry release [38847681503](https://github.com/B4rz99/fidy-ai/actions/runs/38847681503)
stopped before promotion with HTTP 503 at candidate smoke admission. Independent read-only checks
found the smoke schema present, native erasure generation `initial`, no approved erasure cases,
and the private registry checkpoint missing. The erasure guard refuses that uninitialized access;
the protected candidate-bootstrap routing repair is tracked in
[PR #1351](https://github.com/B4rz99/fidy-ai/pull/1351). Protected operator initialization subsequently
returned 204, and [release 38899280216](https://github.com/B4rz99/fidy-ai/actions/runs/38899280216)
passed both candidate/intermediate pairings, promotion and normal-traffic checks. Public health and
the web artifact both report `0f2df68a9233094e40223fab15d167b671cced24` and contract digest
`44612b70c28a1d5456d7319ed3563a62176294f0fd59efc5ffc9d55ec67bd403`.
The existing browser session authorized a fresh status read returning 200 with the original paid
period and succeeded attempt; Upgrade rendered that standing after explicit retry from an initial
unavailable result. The initial refusal was not diagnosed as a persistent defect. Anonymous status
returned 401/no-store and foreign-Origin enrollment returned 403/no-store. DaviPlata's Sandbox OTP
preflight returned 200 with Fidy's Origin, POST and required headers allowed; this alone is not the
deployed browser OTP journey.

The approved deployed card sequence then passed on the existing unpaid Microsoft QA account at
that revision. Initial status returned Free, no paid Subscription and no BillingAttempts. A weekly
COP 9,900 Sandbox decline finalized without a paid period; a fresh enrollment reused that source
without card re-entry, and its explicitly submitted retry also finalized as failed. After the second
decline, the browser exposed retry and replacement actions. Replacement opened blank card fields
and unchecked provider terms; the approved synthetic replacement card settled successfully, and a
fresh status read showed Pro with the new weekly paid period. An indexed read independently
confirmed both original failed attempts and their retry clearances remained, with zero paid periods
for either decline and exactly one for the replacement. No real charges were made. The browser
session expired during the first reconciliation, requiring returning-user login before retry.
An additional indexed read confirmed retry reused the original source, replacement retired that
source, and exactly one replacement source was active before cancellation.

Approved cancellation of that Sandbox Subscription returned `detached`; repeating the call returned
the identical receipt. Canonical status retained Pro and the paid-through instant
`2026-10-23T12:51:10.000Z`. An indexed read independently confirmed the durable cancellation,
one paid period, zero armed collections and zero follow-up messages. The temporary Subscription
Retry QA grant was revoked after fresh Microsoft login; its subsequent canonical read returned
unauthenticated, and its isolated native credential and local grant metadata were cleared.
Four rendered payment regressions also passed against a freshly built isolated browser/Core topology,
including explicit retry, replacement and replacement after reload. This completes the approved
live card sequence; the deployed wallet browser and recovery checks above remain separate gaps.

Unattended Production follow-up on 2026-10-16, 13:43–13:48 UTC, confirmed revision
`17d62a7ae6143615fdc48b911da79305f44e0e6b` and contract digest
`cf1813f589f1c81fc8e96b395631f1fafdfb128e99c2557709b6b1b5a50cd812` on API health and the web artifact.
Ten bounded HTTP probes passed: anonymous billing reads/enrollment returned 401/no-store,
foreign-Origin preparation/submission returned 403 without credential CORS, and malformed/forged
Wompi callbacks returned 400/no-store. An indexed read confirmed zero evidence for the forged
synthetic transaction. The existing three QA attempts still had two failures without paid periods
and one success with exactly one paid period; their outboxes were published and none had armed
collections, follow-ups or renewals. Cancellation remained detached with no later attempts.
The approved and retry Cloudflare Workflow instances both reported complete, each with one collection
step attempt; this is ordinary execution evidence, not interruption/replay proof.

Core version `c321abfc-0208-460f-be71-4be1a50e2937` served 100% traffic with compatibility date
`2026-09-08`, flag `new_module_registry`, Sandbox billing and real DaviPlata activation disabled.
Wrangler version: `4.149.0`. The deployed browser exposed 401 responses from both Sandbox OTP
operations using an intentionally invalid synthetic credential, verifying the CSP/CORS rejection
path. Successful OTP authorization remains unverified. Restricted local evidence:
`/tmp/fidy-subscription-public-production-results.json`,
`/tmp/fidy-subscription-passive-attempts.json`, `/tmp/fidy-subscription-passive-cancellation.json`
and the approved/declined Workflow inspection files. These checks created no source, payment or grant.

Remaining live checks: successful wallet browser OTP and DaviPlata source cancellation need a fresh
session on an eligible unpaid QA account; scheduled renewal/grace needs an approved Sandbox
Subscription left active until its real due boundary; fault recovery needs an isolated approved
fixture/procedure; price-change email needs an isolated notice to an approved test mailbox.
Global offer changes and arbitrary D1 timestamp/state edits are not substitutes for those proofs.

On 2026-10-17, API health and the web artifact agreed on deployed revision
`15a3408c229e9e4365da4c6ccba377a6d8865010` and the same contract digest above. The prior QA
cancellation remained detached overnight, with zero later attempts, armed collections or follow-ups
(17 rows read, zero written); its paid period is not yet due, so this does not prove scheduled renewal.
Fresh returning Google login on the unpaid QA account allowed Consent, offers, status and enrollment
availability reads (200); availability included DaviPlata. Explicit weekly DaviPlata preparation
returned 400 before provider work. Scoped metadata confirmed a retained older failed Sandbox card
source, no paid period, and no checkout-response or retry-clearance evidence. The one-source guard
therefore blocks a method switch; this account is not a clean wallet fixture. No source, payment or
grant was created, and no billing evidence was edited. Full wallet proof still needs an eligible
account without that retained source, or a separately supported reconciliation path.

Local lifecycle follow-up, 2026-10-18: explicit replacement can reserve Nequi or DaviPlata after
retiring a cleared failed card. Migration `0112_failed_card_wallet_replacement.sql` preserves source,
attempt and authorization history. Each old attempt must have verified retry clearance or an
attributable provider no-charge confirmation matching its reference/environment; pending or approved
evidence, a paid Subscription and wallet retirement remain blocked. A failed state or missing POST
response alone never clears replacement. Fresh Users can choose a wallet without a source to retire.
The rendered decline flow permits method selection, opens fresh terms/authorization, and submits no
second payment automatically. Native local D1 tests cover both wallets, ordinary card retry,
unconfirmed lost responses, pending outcomes (including an existing no-charge confirmation), paid
outcomes and retained original history. Later pending/approved evidence invalidates historical
confirmation even while an attempt still reads failed; clearing one attempt cannot clear a second
unresolved attempt on that source. Rejected replacement preserves source/enrollment state and makes
zero provider calls. Production use of this change remains unverified.
Rerun at local base `226dd9363662cb98d158e351c287c9419ebe3e98` plus this change:
351 native billing checks passed (eight opt-in real-provider cases skipped), 21 web Subscription
checks passed, all nine Upgrade presentation journeys passed, and the three existing built-browser
public Ingress/Core/local D1 Subscription journeys passed. The new card-to-wallet browser check
controls enrollment responses; the native replacement matrix uses real local D1 and controlled
Wompi. These results do not establish a deployed wallet authorization or cancellation.

The same 351 native, 21 web and 12 browser checks passed again on the quota-repair candidate
`9d2181e649d0979ae3dd907152b2a4aea7961871` with this change and Effect 4.0.3. The complete static
verification group passed, including the reviewed edge manifest and forward-migration policy.

Real-provider reruns on trunk `1195aeb38737c77e9ed6e360d98f140b1bb8b2f9` with Effect 4.0.3 passed
all four selected cases each for [Nequi](https://github.com/B4rz99/fidy-ai/actions/runs/39155516916)
and [DaviPlata](https://github.com/B4rz99/fidy-ai/actions/runs/39155519593): weekly/monthly/yearly
approved first payments and a weekly decline without a paid period. DaviPlata also verified actual
Sandbox OTP. These use isolated local D1/activity execution, not deployed wallet or Queue/Workflow
proof; no real money or deployed QA account was involved.

The historical QA card still needs genuine, attributable Wompi no-charge confirmation before reuse;
the local test's synthetic provider case is fixture data, not Production proof. This change does not
add an operator HTTP/CLI confirmation facility, bypass the privileged confirmation ledger, retire
wallets or change paid Subscriptions. No live billing state or provider authorization was changed.

Integration rerun on trunk `c83e35cc51` plus this change: all 351 native billing checks passed
with the pinned Bun runtime when each of the fifteen files ran in a separate process; eight
opt-in provider cases were skipped. Broad single-worker runs had moving native-fixture timeouts,
so those runs are not recorded as passing. The 19 current web Subscription checks passed; all nine
Upgrade and three public Ingress/Core browser journeys passed, including their shared admission
and navigation prerequisites. The four mechanical review gates and two edge-manifest checks
passed. The first full static run was blocked by 26 dependency pins whose updates had reached
the seven-day age condition.

The required dependency refresh admits Effect 4.0.4 and the eligible tooling/platform updates
without changing release-age or vulnerability policy. A clean frozen installation removed stale
duplicate Effect copies; a forced type build, the complete static group and four contract tests
passed. Generated OpenAPI numeric bounds were regenerated from the selected Effect source.
The full native billing run passed all 351 checks (eight provider opt-ins skipped), and all 19
Subscription web checks passed. The final uninstrumented browser run passed all 22 selected
checks: twelve Subscription journeys and ten shared admission/navigation prerequisites. Earlier
DaviPlata runs timed out; two focused diagnostic runs and the final clean run passed, but no
definitive cause was established. Temporary diagnostics were removed; no waits, test retries or
timeout increases were retained. This is local verification, not deployed wallet proof.

Release verification, 2026-10-20: [PR #1364](https://github.com/B4rz99/fidy-ai/pull/1364)
merged as `d179bc162ebc15213b5e1f1e29f1cd2aa7f05c47` after all required checks passed.
The [Production deployment](https://github.com/B4rz99/fidy-ai/actions/runs/39424387530)
passed all three full smoke probes without quota deferral. Public API health, web metadata and
landing metadata independently reported that revision; API and web reported matching contract
digest `43da8b6e7f0bfbed827ab4d6675978f04b5436e9f014bc406b05d673d1c3815e`.
The fresh real-provider [Nequi](https://github.com/B4rz99/fidy-ai/actions/runs/39424452791)
and [DaviPlata](https://github.com/B4rz99/fidy-ai/actions/runs/39424457614) Sandbox workflows
passed all four selected cases each on that revision with Effect 4.0.4. DaviPlata verified actual
Sandbox OTP and reusable source authorization. These workflows exercise real provider responses
with isolated local D1/activity execution; they do not establish a deployed wallet journey or
Queue/Workflow recovery behavior. No real money or deployed QA account was involved.

Remaining deployed checks: wallet authorization through settlement and cancellation on an eligible
account; scheduled renewal/grace at real due dates; isolated Queue/Workflow interruption/replay;
and isolated Price-change notification. Reusing the historical Gmail card still requires genuine,
attributable Wompi no-charge confirmation under the [ambiguity runbook](../../../../../docs/runbooks/billing-ambiguity.md).
No new sign-in is requested while that prerequisite remains unresolved.
The [follow-up CI rerun](https://github.com/B4rz99/fidy-ai/actions/runs/39429914340/attempts/2)
reproduced the sixty-second DaviPlata browser timeout, alongside a Google connection reset.
The deployed release and real-provider protocol results above remain valid. Follow-up diagnosis
reproduced a browser-fixture hang twice: the readiness observer selected an outgoing page's Consent
request, then waited indefinitely for its response after navigation and abort, despite Upgrade
receiving a real Core 200 response. Observing completed GET responses instead passed the controlled
case, without adding waits, retries or timeout increases. The regression uses real browser →
Ingress → Core/local D1 and aborts only the outgoing read. This establishes the reproduced race's
cause; the earlier CI timeout lacked stage evidence, so attribution to that same race remains
unproven. The combined regression, reused-source Subscription, first-card and DaviPlata browser
run passed all 14 checks including shared prerequisites. Temporary stage diagnostics were removed.
Deployed wallet coverage remains separate.

The [next CI run](https://github.com/B4rz99/fidy-ai/actions/runs/39438032993) passed DaviPlata
and the navigation regression but failed an existing Transactions loading assertion. Its full local
shard passed with a real 200 response, so that CI failure was not reproduced locally. The loading
test now holds its request until loading is observed, then requires the real Core response to be
200 before checking that loading ends; the former one-second sleep is removed. That stronger
observation reproduced a real 429 under parallel load: unrelated journeys shared the primary
fixture User's admission budget. The loading and Consent regression journeys now each own a
separate seeded User through the same public pairing flow. The resulting full local shard passed
91 checks, with three pre-existing skips. No counters, limits, deadlines or admission guards changed.

Owners: [Core decisions](operations.ts), [canonical API](../../shell/subscription/contract.ts),
[native billing](../../../cloudflare/subscription/operations.ts),
[AccessTier guard](../../shell/access-tier/operations.ts), and
[commercial allowances](../../../../../docs/operations/commercial-allowances.md).
