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

## Calibrate the hosted D1 fixture

The historical calibration lives at `15cfe773cd263b6a3d4e1b6e1b958f233cdde84f`. Its protected, disposable database and its SQL plan belong to the comparator. Run the documented local rehearsal from a separate checkout of that revision. Record the comparator revision, report, plan digest and measured headroom with the comparison. The release Worker graph has no D1 binding.

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

### Pinned local reference

Use Bun 1.4.4, Python 3.10+, OpenSSL, Chromium, and free loopback ports 4183–4185.
Install the repository dependencies in both checkouts. Apply the three test-only fixtures to a
disposable checkout of the pinned D1 revision. The application, schema, ingress and client come
from that checkout. Record any proposed baseline replacement, its intervening behavior changes,
and the decision on #2226 before collecting observations.

```sh
git worktree add --detach ../fidy-d1-reference fb53d9e755c14393048dc945fc0b7f117730d872
(cd ../fidy-d1-reference && bun install --frozen-lockfile)
git -C ../fidy-d1-reference restore --source=972ecaa22bb58ab472de2e9458c76290c72aa09d --worktree -- \
  apps/server/cloudflare/browser-assessment.test-fixture.ts \
  apps/server/cloudflare/browser-acceptance-preview.ts apps/server/cloudflare/browser-acceptance-seed.ts
bun install --frozen-lockfile
bunx playwright install chromium
python3 scripts/infra-performance/reference/run.py --d1 ../fidy-d1-reference --dataset production
```

Set `ASSESSMENT_CHROMIUM` to select an existing Chromium executable. Use `--dataset small` for
500 Transactions, `--dataset extreme` for 100,000 and `--dataset breaking` for the separate
million-Transaction stress run. The `production` dataset contains eight originals, one linked
pair, two Currencies, two RecurringPlans with two revisions each, and four NeedsReviewItems.
The command runs every profile locally. It verifies the effective Transaction count and each
fixture family's stored counts before Login.

Open the freshly loaded Transactions workspace, refresh its November 2026 history, correct one
fixed Counterparty, and observe the committed Correction in the refreshed ledger. The runner drives
these actions automatically. It verifies ordering, page length, revision, all unaffected records,
Session Audit, and commercial accounting. The browser carries a real WebSession through the
canonical ingress. The local test server records ingress-to-complete-body time. Chromium records
each request through body completion, and the journey clock ends when the matching row is
enabled and has had a paint opportunity. This harness uses local acceptance composition and
cannot observe a deployed Worker or Durable Object reconstruction.

To compare the completed native candidate, supply its clean checkout with the same loopback
fixture protocol:

The command above records historical reference observations only. The native acceptance run uses the closed release’s own matched Web and API Workers, deployed revision and namespace identities. Report both observations and their independent provenance when evaluating a paired result.

## Recovery verification

After fresh quota headroom is confirmed, verify public OAuth discovery and actual signed-in
Category and dashboard requests, including their admission/Audit writes. Then run the complete
public representation and agent discovery suite. Health and deployment metadata prove a revision
is present; they do not prove storage-backed service readiness. A release already serving its
candidate versions cannot be staged again as a new candidate: use the documented recovery path
or a fresh validated release rather than repeating the same deployment blindly.
