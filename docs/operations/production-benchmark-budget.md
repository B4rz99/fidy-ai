# Production benchmark budget

A separate D1 database shares its account allowance with Production.

Cloudflare's [Free limit enforcement](https://developers.cloudflare.com/changelog/post/2026-09-01-d1-free-tier-limit-enforcement/)
blocks queries after the shared daily limit until midnight UTC. Admission and Audit writes mean
that an authenticated GET can fail while `SELECT 1` and public health still succeed.
A [Workers Paid upgrade](https://developers.cloudflare.com/workers/platform/pricing/)
requires the account owner's approval of recurring charges; it is not an automatic recovery step.

## Before any hosted experiment

1. Run the complete fixture locally with native workerd first. Count schema installation, seed
   records, indexes, triggers, admission, Audit, retries and cleanup.
2. Obtain fresh account-wide D1 analytics for the current UTC day, including deleted databases.
   An empty result, error or missing counter is unavailable evidence, not zero usage. Analytics
   may lag; the counters do not reserve capacity against concurrent production work.
3. Evaluate `scripts/infra-performance/d1-budget.ts` with the observation and full experiment
   estimate as JSON on stdin. It uses its own clock. Unknown, foreign, stale, future or previous-day
   observations refuse. Maximum experiment: 100,000 rows read and 5,000 written. Preserve at least
   2,500,000 reads and 50,000 writes for production. A refusal stops provisioning.
4. Serialize experiments sharing an account. Carry the admitted ceiling into the runner. Before
   every bounded batch or burst, check its conservative maximum against remaining experiment
   allowance; then accumulate actual `meta.rows_read` and `meta.rows_written`. Missing metadata,
   unexpected growth or an exhausted ceiling stops further work. Do not retry a failed fixture
   under a new name to evade this accounting. Keep cleanup possible without schema or data writes.
5. Independently verify deletion of every Worker, Workflow, database and bucket. Skip an R2
   delete call when its object list is empty. Retain failed observations and cleanup evidence.

The preflight is a conservative check, not an atomic account reservation. The CLI is covered by
`test:ci-tools`; temporary hosted runners must explicitly invoke it and enforce its returned
ceiling. A separate Cloudflare account is the way to isolate test allowance from production.

## Recovery verification

After fresh quota headroom is confirmed, verify public OAuth discovery and actual signed-in
Category and dashboard requests, including their admission/Audit writes. Then run the complete
public representation and agent discovery suite. Health and deployment metadata prove a revision
is present; they do not prove storage-backed service readiness. A release already serving its
candidate versions cannot be staged again as a new candidate: use the documented recovery path
or a fresh validated release rather than repeating the same deployment blindly.
