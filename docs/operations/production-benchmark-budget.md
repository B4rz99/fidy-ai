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

Historical hosted runners under ignored `reports/performance/` are retired. In particular, the
shared-path and locality runners must stop before provisioning: they cannot account for all
coordinator work, migrations, retries and cleanup. A successful preflight alone does not make them
safe to reuse. A replacement must demonstrate runtime budget enforcement before hosted execution.

## Local investigation while hosted work is unavailable

Use native integration tests with the existing observer from the repository root:

```sh
bun node_modules/vitest/vitest.mjs run --root apps/server \
  --config ../../scripts/infra-performance/vitest.config.ts \
  cloudflare/public-worker-browser-entry.test.ts \
  cloudflare/transactions/transactions.test.ts \
  cloudflare/budgets/budgets.test.ts \
  cloudflare/recurring-plans/recurring-plans.test.ts \
  cloudflare/dashboard/dashboard.test.ts \
  cloudflare/ingestion/statement-review-budget.test.ts \
  cloudflare/tokens/pats.test.ts \
  cloudflare/oauth-agents/oauth-management.test.ts \
  cloudflare/subscription/subscription-queries.test.ts \
  cloudflare/consent/browser.test.ts --silent=false
```

`INFRA_REQUEST` covers Core fetch, including bootstrap and other non-canonical transports.
`INFRA_OWNER` covers the held owner only. The records include response stage timings when present.
Direct Core D1 counts exclude coordinator work; host-process CPU excludes workerd. Missing stage
timings are unavailable evidence, not zero cost. Do not combine owner and request records as though
they were independent requests or sum nested stage durations.

For complete screen readiness, use the local browser assessment on the isolated CLI topology after
checking ports 4183–4185 are unused (see `.patterns/testing.md`):

```sh
cd apps/web
CLI_ACCEPTANCE_MODE=cli FIDY_ASSESSMENT=small FIDY_ASSESSMENT_NETWORK=normal \
  FIDY_ASSESSMENT_COLD_REPEATS=1 PREVIEW_COMPRESSION=gzip \
  bun --bun playwright test --config playwright.assessment.config.ts \
  --grep 'assesses isolated cold documents'
```

This uses local storage and synthetic records. Cold documents are new browser documents, not proof
of a new Worker isolate. Local timings distinguish processing from request waterfalls; they cannot
establish Cloudflare placement, production network latency or deployed cold-start performance.
Keep generated profiles and measurements in ignored results and attach findings to the relevant PR.

For fresh documents, the assessment records enabled controls, visible populated content and the
first Transaction registration interaction independently of response completion. `nativeContentDomMs`
marks the DOM predicate; `nativeContentReadyMs` follows two animation callbacks, which provide a
paint opportunity rather than a compositor paint timestamp. `nativeInteractionStartMs` and
`nativeInteractionReadyMs` bracket the first registration click and its visible form when cold
interactions are enabled. These are document-relative observations, not timings of each later
navigation. Unobserved milestones are `-1`, not zero. Compare them with the separately recorded
request/body timings; neither the final API response nor an early enabled button establishes
populated-content readiness.

## Recovery verification

After fresh quota headroom is confirmed, verify public OAuth discovery and actual signed-in
Category and dashboard requests, including their admission/Audit writes. Then run the complete
public representation and agent discovery suite. Health and deployment metadata prove a revision
is present; they do not prove storage-backed service readiness. A release already serving its
candidate versions cannot be staged again as a new candidate: use the documented recovery path
or a fresh validated release rather than repeating the same deployment blindly.
