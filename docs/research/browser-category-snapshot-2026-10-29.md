# Bound browser Category snapshot

The browser Category GET previously committed three separately fenced D1 units: admission,
Category work, then lease release and quota standing. The candidate prepares the credential lookup,
pressure, bounded Category projection, Audit and standing in one native batch.
It still obtains a fresh R2 recovery generation for that batch. No credential, Consent, generation,
response or standing is cached.

The Category owner retains its SQL and response codec. Admission supplies the unresolved exact
cookie authority. Projection, Audit and standing recheck the same credential in that batch.
The conditional Audit assertion uses that live credential selection. Authorization header presence preserves credential precedence,
and requests with query parameters retain the existing path. Lost committed responses never replay
owner work. A refusal rechecks current authority.

D1 executes the write-containing batch as one serialized transaction. The Category read checks
existing live leases plus itself against the same two-request cap, retains rate pacing and clears
expired leases. Its projection, Audit and standing finish inside that transaction; presentation
only encodes the bounded response. A transient lease inserted/deleted in this same transaction
would never be visible to another transaction. Provider work and other operations retain leases.
See Cloudflare's [D1 concurrency model](https://developers.cloudflare.com/d1/reference/faq/).

## Local evidence

Native workerd fixtures cover revoked/expired cookies, withdrawn Consent, absent/mismatched mounted
bindings, invalid Authorization, rate/concurrency refusals, ignored Audit, invalid projection,
recovery-generation change and lost committed response. Another User's active TrialPeriod cannot
change the caller's disclosed standing. The focused Category, admission and quota run passed 48 tests.

The [local SQL footprint](browser-category-snapshot-local-footprint-2026-10-29.json) uses independent
fresh native databases with the full schema and synthetic browser credentials. Both variants use
Effect 4.0.6 to compare SQL work; baseline server source is `90bdfb2`. Response hashes match.

| Per successful Category read           | Baseline | Candidate |
| -------------------------------------- | -------: | --------: |
| Fresh R2 generation reads / D1 batches |    3 / 3 |     1 / 1 |
| Native rows written                    |       23 |        16 |
| Native rows read                       |       41 |        40 |

This establishes three times fewer remote units, 30.4% fewer writes and slightly fewer rows read. It does not establish production latency, total CPU, memory, capacity or invoice gains.
Schema installation alone measured 1,474 writes across 1,108 statements.

## Hosted and production verification pending

The initial hosted fixture failed during schema installation because the account had exhausted
its shared Free D1 write allowance. No timed requests completed; there is no hosted speedup result
from that attempt. All six provisioned resources independently returned 404 after cleanup.

The user chose to remain on Free and verify recovery after midnight UTC on 30 October. See the
[production benchmark budget](../operations/production-benchmark-budget.md). A fresh account-wide
preflight now refuses exhausted headroom; the native fixture additionally reserves each bounded
batch/request, checks actual row metadata, and restores usage from completed Workflow steps.
Its meter has local checks; the first successful hosted comparison is recorded below. The next hosted
comparison pins the baseline Effect family to 4.0.5 and candidate family to 4.0.6, matching the
release dependency change. Any observed release ratio includes that dependency update.

Capture a healthy authenticated production baseline before promotion, then repeat the same paced
requests, account, dataset and browser after deployment. Retain failures, report sample counts and
verify response equivalence. Keep issue #1589 open: universal 2x improvement remains unconfirmed.

## Reset verification on 30 October

At 00:03 UTC, account-wide D1 analytics for the new day reported 477 rows read and 96
written. Public OAuth discovery recovered to HTTP 200. The complete credential-free
production edge smoke passed, including OAuth discovery and rejected operations; this does
not establish signed-in Category availability. All required CI checks for candidate `f15d4e6af5`
passed, including all four native Cloudflare adapter shards.

The first post-reset preflight refused unavailable analytics before provisioning. A later
fresh preflight admitted the fixture, which stopped during schema setup when a batch exceeded
its read estimate. No timed trial completed. Local reproduction identifies the final eight
schema statements as 5,099 reads against the temporary runner's 5,000-read reservation; the
complete schema remains 8,299 reads and 1,474 writes locally. The temporary runner's batch
read reservation was raised to 10,000 within the unchanged 100,000-read/5,000-write experiment
ceiling. The corrected continuation is recorded below. All six provisioned resources
independently returned HTTP 404 after cleanup. Retain the failed attempt in accounting before
any further experiment; do not reset its spent allowance by using a different resource name.

The scheduled run could list in-app tabs but could not access the signed-in page or debugger
connection. An authenticated production baseline is therefore still missing. Keep the PR in
draft until that baseline and controlled hosted evidence are available; do not infer browser
recovery or a production speedup from the public checks.

## Hosted continuation

Cloudflare account analytics independently confirmed the deleted failed fixture spent 8,299
reads and 1,474 writes. The continuation carried a larger reservation of 20,000 reads and
2,000 writes for that attempt into the same 100,000-read/5,000-write ceiling. It used two
ABBA blocks rather than three, with four eight-read bursts per variant. Fresh account-wide
preflight remained mandatory before provisioning and each block. Cloudflare's documented
[account-based rate limiting](https://developers.cloudflare.com/analytics/graphql-api/account-based-rate-limiting/)
header (`X-Rate-Limit-Type: account-based`) isolated these analytics requests from the busy
per-user query quota; credentials and the Free plan were unchanged.

The [retained hosted observations](browser-category-snapshot-hosted-2026-10-30.json) contain
64 HTTP 200 completions and zero refusals. Median burst completion was 2,358.5 ms for the
baseline and 811.5 ms for the candidate: **2.91x faster** in this synthetic native comparison.
Maximum observed burst completion was 2,719 ms versus 1,520 ms (**1.79x**); four bursts per
variant do not establish a reliable tail percentile. All projections were empty; this does
not establish production, populated-data, provider extraction, CPU, memory or invoice gains.
Both variants used the same browser policy; baseline server Effect was 4.0.5 and candidate
4.0.6, so the ratio includes that dependency change.

The meter ended at 31,395 reads and 4,614 writes including its conservative prior-attempt
reservation; measured writes across both fixtures were 4,088. All six continuation resources
independently returned HTTP 404 after cleanup. Signed-in production baseline and candidate
verification are still blocked by browser access; the candidate remains in draft.
