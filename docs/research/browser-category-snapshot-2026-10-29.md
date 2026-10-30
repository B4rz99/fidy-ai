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
Its meter has local checks; hosted validation still requires fresh headroom. The next hosted
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
ceiling. This correction has not been revalidated hosted. All six provisioned resources
independently returned HTTP 404 after cleanup. Retain the failed attempt in accounting before
any further experiment; do not reset its spent allowance by using a different resource name.

The scheduled run could list in-app tabs but could not access the signed-in page or debugger
connection. An authenticated production baseline is therefore still missing. Keep the PR in
draft until that baseline and controlled hosted evidence are available; do not infer browser
recovery or a production speedup from the public checks.
