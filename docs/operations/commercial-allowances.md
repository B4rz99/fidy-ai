# Commercial Free allowances (#35)

D1 is the accounting authority. Commercial allowances are independent of
[resource admission and spend protection](admission-coverage.md); neither the public Worker nor a
User's Durable Object owns a counter.

| Allowance                | Free limit | Consumption boundary                                                                        |
| ------------------------ | ---------- | ------------------------------------------------------------------------------------------- |
| Forwarded email          | 50         | First processing admission, not receipt retention                                           |
| Receipt/screenshot       | 2 combined | Atomic accepted media submission, even when extraction is unavailable                       |
| Hosted history           | 2 Turns    | First successful publication of newly loaded saved Transactions in a Turn, before inference |
| External canonical calls | 50         | One admitted PAT or OAuth MCP envelope, including domain failures and atomic batches        |

All four periods are half-open calendar months in `America/Bogota`, with no rollover. Live Trial
and Pro standing is Uncapped commercially, not exempt from Consent, capabilities, resource
protection, or provider bounds. Standing is re-derived at admission. Creation, empty/failed history
reads, aggregates, and previously loaded conversation do not consume hosted-history units. Browser
and hosted canonical calls do not consume external-call units.

## Canonical admission and replay

Authentication, live capabilities, and external input validation precede commercial consumption.
User protection is separate: 60 requests/minute, burst 10, two concurrent requests, and 90-second
leases. Unresolved-source protection applies to final unauthenticated refusals, not valid credentials
sharing a NAT. Trusted Cloudflare source evidence is forwarded by the public Worker.

`quota.getQuota` and `subscription.getUpgradeUrl` use shared audited owner queries and remain
commercially unmetered at zero. They retain security protection. Quota exhaustion returns 429 with
an allowance and exact period reset; security refusals use `rate_limited` and `Retry-After`, not a
commercial reset.

The response protocol publishes `Fidy-Canonical-Allowance: canonical_call`,
`Fidy-Canonical-Limit`, `Fidy-Canonical-Remaining` and `Fidy-Canonical-Reset`. Free limit and remaining
are non-negative integer text; Trial/Pro publish `uncapped` for both. Reset is an absolute ISO UTC
instant, not Retry-After. `shell/quotas/contract.ts` owns the reusable `CanonicalAllowance` codec
and header names, published outward through `@fidy/server/client`. Consumers validate the whole
projection; missing or malformed metadata means unavailable, never an inferred zero. The CLI
renders valid standing and unavailable guidance on stderr, preserving canonical JSON stdout and
making no additional quota request. It suppresses a visible monthly counter/reset for uncapped
standing and does not equate uncapped commercial access with unlimited security capacity.

OAuth MCP returns the same validated wire projection in tool-result `_meta` under
`co.fidy/canonicalAllowance`, keeping `{ data, next }` and `{ error, next }` unchanged.
`quota.getQuota` reports the same shared User standing. Clients may supply a bounded
`co.fidy/retryKey` in request `_meta`; it follows the same fixed 24-hour, exact-User/operation/input
contract as the HTTP `Fidy-Retry-Key`. A PAT and an authorized OAuth credential may replay the
same ordinary outcome, with current capability, Consent and attributable access evidence.
Multiple clients, connections, rotation, refresh and new approval do not own or reset a meter.
Protocol discovery, registration, approval and refresh remain separately bounded security work.

A sensitive invocation consumes its canonical unit before native review preparation. Its
server-created continuation rekeys that same consumption identity to the exact connection,
reference, canonical operation and normalized input digest, preserving its original period,
acceptance instant and units. A native decision resumes the same envelope even across a month
boundary. The confirmation owner still consumes authority once; subsequent decisions are refused
without another commercial unit, and changing the operation or inputs cannot reuse the admitted
identity. Sensitive work follows that single-use contract rather than cached-response replay.

The browser honors bounded `Retry-After` pacing only for decoded canonical
`ResourceLimited` refusals, which prove non-admission. It retries at most six times within the
existing 15-second deadline; it does not replay uncertain mutations or commercial exhaustion.

Retry identity binds one User, operation, and exact normalized input. Accepted responses replay
without another unit or domain execution for a fixed 24 hours from first acceptance. Current
authority is checked again before disclosure, and current-credential replay access is audited. Admission
alone cannot advance successful PAT activity. Replay bodies, acceptance identities, leases,
security buckets, and old consumption identities have bounded scheduled cleanup.

## Ingestion and retention

Forwarded email beyond Free processing capacity is durably deferred without a provider outbox.
Reevaluation follows the next period or live Trial/Pro standing. Retained bytes and deferred work
remain separately bounded; scheduling timestamps survive refusal rollback to prevent starvation.

Verified WhatsApp images cross one atomic publication unit: fresh association and Consent,
capacity assertion, commercial consumption, current User context, submission, accountability,
visible NeedsReviewItem, and identity-only outbox. Exact delivery replay is free; altered delivery
material conflicts. Pasted text is not a media submission. Full retrieval/extraction belongs to
#21; accepted media currently remains visibly `extraction-unavailable`, never silently successful.
No provider retrieval or bytes are retained by this admission path.

Media locator/caption/outbox retention is 30 days; submission/review/accountability metadata is
retained for one year. Scheduled cleanup processes at most 512 identities per activity. The
retained input digest permits exact replay after locator cleanup without restoring personal
material or charging again.
