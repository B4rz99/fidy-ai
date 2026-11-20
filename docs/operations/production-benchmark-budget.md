# Production benchmark budget

A separate D1 database shares its account allowance with Production.

Cloudflare's [Free limit enforcement](https://developers.cloudflare.com/changelog/post/2026-09-01-d1-free-tier-limit-enforcement/)
blocks queries after the shared daily limit until midnight UTC. Admission and Audit writes mean
that an authenticated GET can fail while `SELECT 1` and public health still succeed.
A [Workers Paid upgrade](https://developers.cloudflare.com/workers/platform/pricing/)
requires the account owner's approval of recurring charges; it is not an automatic recovery step.

For the storage comparison, run one ordinary-network read profile and small mutation correctness
checks on the eight-original-Transaction fixture. Charge the complete experiment, including setup
and cleanup, against current D1 account headroom. Run repeated mutation timings and the 20-User
offered-load comparison on workerd. [Storage acceptance criteria](https://github.com/B4rz99/fidy-ai/issues/2226)

## Before any hosted experiment

1. Run the complete fixture locally with native workerd first. Count schema installation, seed
   records, indexes, triggers, admission, Audit, retries and cleanup.
2. Obtain fresh account-wide D1 analytics for the current UTC day, including deleted databases.
   An empty result, error or missing counter is unavailable evidence, not zero usage. Analytics
   may lag; the counters do not reserve capacity against concurrent production work.
3. Evaluate `scripts/infra-performance/d1-budget.ts` with the observation and full experiment
   estimate as JSON on stdin. It uses its own clock. Unknown, foreign, stale, future or previous-day
   observations refuse. Limit each experiment to 100,000 rows read. Admit writes against current
   account usage and the complete measured workload. Preserve at least
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

## Local investigation

Use `bun run verify --group cloudflare-adapters` for the native owner and Queue contracts. `bun run dev:browser` exercises a synthetic User on the local native browser topology. Record host and Worker revisions, synthetic identities, measured boundaries and any missing observations when reporting timings.

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
Use those small-fixture dimensions for the [hosted comparison](https://github.com/B4rz99/fidy-ai/issues/2259).
Run `--dataset extreme` on both variants in workerd. Record fixture counts, operations and
network profiles for each result. The 4,754-write calibration below covers 30 paired history
reads for the eight-original fixture. Other journeys need their own measured budget, including
fixture preparation, admission, Audit and cleanup.

Open the freshly loaded Transactions workspace, refresh its November 2026 history, correct one
fixed Counterparty, and observe the committed Correction in the refreshed ledger. The runner drives
these actions automatically. It verifies ordering, page length, revision, all unaffected records,
Session Audit, and commercial accounting. The browser carries a real WebSession through the
canonical ingress. The local test server records ingress-to-complete-body time. Chromium records
each request through body completion, and the journey clock ends when the matching row is
enabled and has had a paint opportunity. This harness uses local acceptance composition and
cannot observe a deployed Worker or Durable Object reconstruction.

The **Compare the storage reference** workflow runs the pinned D1 checkout and the native
candidate on one GitHub-hosted runner. It checks one pair for equivalent results before measuring
30 alternating pairs. Its artifact records the revisions, fixture counts, payload digests,
accountability and timing at each boundary. To repeat the comparison on a prepared host, add
`--do . --pairs 30` to the command above. Hosted release acceptance separately measures the
deployed Workers from the recorded network origin.

The default run begins navigation immediately after authenticated fixture setup. To measure
the same sequential journeys after a quiet interval, pass `--setup-idle-ms 2000` or select
`setup_idle_ms=2000` in the workflow. Both variants wait once before the first navigation.
Each run records its interval in the plan and retains refusals during setup and timed requests.
Compare the two starting conditions separately.

## Recovery verification

After fresh quota headroom is confirmed, verify public OAuth discovery and actual signed-in
Category and dashboard requests, including their admission/Audit writes. Then run the complete
public representation and agent discovery suite. Health and deployment metadata prove a revision
is present; they do not prove storage-backed service readiness. A release already serving its
candidate versions cannot be staged again as a new candidate: use the documented recovery path
or a fresh validated release rather than repeating the same deployment blindly.

## Rehearse the protected HTTP pilot

The **Rehearse the storage HTTP comparison** workflow requires no Cloudflare credentials. It checks
the frozen D1 revision, builds its actual Ingress and Core modules, and uses the historical
calibration plan on local workerd. The pilot sends a bound WebSession through the named erasure
registry to read `GET /transactions?limit=25`. The comparison verifies ordered identities, exact
Money and the full response digest. The rehearsal records the native cost and successful Session
Audit of 30 reads at one request per second. It compares the response to the native User-store
fixture. The protected Worker package is suitable only for these rehearsed routes and SQL batches.
It includes a native batch ceiling for each SQL shape and a separate total ceiling per HTTP request.

Use the artifact's `d1/manifest.json`, `d1/limits.json`, `d1/plan.json` and `d1/probe.json` to
inspect the module and plan digests, verified counts, calibration costs, authority setup, Audit,
and one-pair and 30-pair estimates. Limits from local workerd still require a fresh account-wide
preflight. The private Ingress requires a fresh experiment key and deadline. The packaged Core
serves no cron, alarm or queue. The D1 binding, erasure bucket, and SQLite coordinator belong to
the isolated comparator. Only the finite private Ingress may have an experiment URL.

### Check a comparator before provisioning

Use the ordinary pilot entry point with the verified bundle from `cells/prepare.py`:

```sh
python3 scripts/infra-performance/cells/pilot.py \
  --bundle "$VERIFIED_D1_BUNDLE" --out apps/server/test-results/preparation-check
```

This writes `report.json` and exits before looking up account credentials. The report names the
protected owner command. The offline pilot verifies the frozen plan, rehearsal digests and the
experiment-size limit. A smaller plan still needs the scoped native fixture and account admission.

The workflow runs this pilot entry point separately with the materialized canonical fixture, the
empty-schema canonical control and the historical fixed-ID control. The materialized run additionally
passes its measured 30-pair estimate to the same size-only budget check. An in-budget estimate
requires a fresh account observation before protected admission.

The workflow also stops the materialized workerd comparator after an authenticated, fixture-checked
read, disposes the graph, and independently verifies the runner's socket and owned temporary
directory have gone. Its `storage-preparation` artifacts record the refusals and this local cleanup.

### Run the protected Transaction comparator

Generate one unpredictable `fidy-2259-<12 lowercase hex>` prefix before collecting the protected
`performance-1` native fixture. Keep that prefix through cleanup. Build the materialized package
from the authenticated native receipt in the protected runner. Pin the SHA-256 of `manifest.json`
through the trusted build output. The receipt, Worker modules, SQL, Transaction records and bound
WebSession stay in private runner storage. Give the owner the pinned digest independently of the
package directory. Use `--pairs 1` for a pilot or `--pairs 30` for the alternating isolated cohort.

```bash
owner=scripts/infra-performance/cells/owner.py
args=(--prefix "$RESOURCE_PREFIX" --revision "$NATIVE_REVISION" --fixture "$PRIVATE_FIXTURE"
      --bundle "$VERIFIED_D1_BUNDLE" --manifest-sha256 "$TRUSTED_MANIFEST_SHA256" --pairs 30)
python3 "$owner" propose "${args[@]}" --out "$PRIVATE_OUTPUT/proposal"
python3 "$owner" run "${args[@]}" --core-version "$APPROVED_NATIVE_CORE_VERSION" \
  --ingress-version "$APPROVED_NATIVE_INGRESS_VERSION" --maximum-reads "$APPROVED_READS" --maximum-writes "$APPROVED_WRITES" \
  --out "$PRIVATE_OUTPUT/attempt"
```

`propose` verifies the native binding, complete final-schema import, frozen package and ceilings
for every SQL batch, Login, inspection, history read and final Audit check. Use the returned read
and write maximums when approving the run. `run` obtains current account-wide D1 GraphQL analytics,
adds previously accounted same-day experiment work and evaluates the repository's Free policy.
Before taking custody, it independently reads the current native installation and authenticates
the approved Core and Ingress version UUIDs, closed authority, source revision and exact signer
fingerprint. It repeats that check after collection.
The runner requires a protected `SMOKE_PROOF`, `CLOUDFLARE_ACCOUNT_ID` and an account-scoped
Cloudflare API token with D1, Worker script, Durable Object, R2 and Analytics access. Pin the native
Core fixture-signing public key through `FIDY_NATIVE_FIXTURE_PUBLIC_KEY`. On protected `trunk`, the owner verifies the deployment account token's own ID and derives a
40-minute R2 session in memory using Cloudflare's documented local-signing flow. The AWS CLI
receives only that session's GetObject and PutObject authority for the single key
`fidy-native-release-smoke/protected-storage/account/<account-id>/d1-ledger.json`.
[Temporary credentials and action scoping](https://developers.cloudflare.com/r2/api/s3/temporary-credentials/)

All comparator
runs use that existing custody bucket and object. Preserve its contents across runners and days.
R2 evaluates conditional writes atomically. [R2 conditional operations](https://developers.cloudflare.com/r2/api/s3/api/)

The inventory contains one D1 database, one Standard R2 bucket containing the recovery generation,
two Workers and one SQLite coordinator namespace. Core stays private. The signed-in HTTP test uses
only the expiring private Ingress on its disposable workers.dev address. The run sets a 20-minute
request deadline. Cleanup retires the coordinator class, independently rediscovers each owned
resource, verifies absence and records the resulting inventory receipt. If the runner stops,
wait for the deadline and 90-second in-flight grace period and run the following independently.

```bash
python3 scripts/infra-performance/cells/owner.py cleanup --prefix "$RESOURCE_PREFIX" \
  --out "$PRIVATE_OUTPUT/recovery"
```

Each resource mutation takes a fresh conditional account claim immediately before dispatch. A
second cleanup runner waits for the prior cleanup claim to expire. Worker publication retains the
version IDs returned for the two uploaded modules and verifies the active versions and bindings
while Ingress is closed, then checks them again on opening. For D1 and bucket creation, recovery
requires the exact provider-issued UUID or creation timestamp. If the creation reply was lost and
an identically named resource exists, the ledger retains the unresolved intent. An operator must
establish ownership independently from the provider before deleting it. Other owned resources can
still be removed. Unknown D1 batch cost stays fenced after resource deletion. Preserve the account ledger for
independent reconciliation. The only publishable runner output is `report.json`. Its attempt data
contains status, response digests, byte counts and timings. Unobserved lifecycle remains missing
acceptance evidence. The credential-free storage HTTP workflow drives this owner through a restored
workerd fixture, loses the reply to an authenticated read and resumes teardown from account state.

### Canonical Transaction fixture

The **Rehearse the storage HTTP comparison** workflow also captures eight manual originals
with one authenticated, all-or-nothing batch, links the matching pair, then inspects the seven
effective Transactions and both retained originals. A resumed run first reads existing state.
The private journal contains the release, synthetic cohort member, attempt stages, an originals
digest, and the two link handles. An unresolved empty or conflicting result stops further
mutation. The complete synthetic response evidence lives separately from the journal.

Financial equivalence includes every field in the canonical history and inspection responses:
Transaction identity, exact amount and Currency, direction, Counterparty, Category, absence of
notes, occurrence and capture times, revision, ordering, continuation, visible and suppressed
identities, both originals, and the source kinds returned by the owner. Manual capture creates
a SourceAttestation and records which fields the User supplied. The disposable workerd fixture
can verify those actual identities, capture context and decision flags. The mounted privacy scope
returns effective Transactions. The complete SourceAttestation route and the observation of
individual hosted SourceAttestation IDs are separate evidence requirements.

The canonical D1 mirror requires the actual native fixture proof. It replaces the historic
fixture's two Transaction preparation batches and retains the frozen application, installed
schema, SQL triggers and unrelated calibration batches. Repeating the workerd rehearsal measures
the altered setup, complete HTTP Login, eight inspections, history and Audit. Inspect both the
one-pair and 30-pair estimates in `canonical-mirror/probe.json`. Refuse a plan exceeding the
shared-account ceiling before provisioning. Budget, Recurring and Needs Review equivalence still
require their own verified native preparations.

### Rehearse final-schema preparation

Pass `--snapshot` with `--canonical-fixture` to `cells/prepare.py` to derive a disposable
comparator schema on a GitHub runner. The frozen Alchemy migration provider first replays every
migration into a private workerd D1 database and records its migration ledger. A second database
receives the resulting table, index, view and trigger SQL and the exact seed and ledger rows.
The verifier compares the complete schema, trigger order, table contents and foreign key check
before applying the same canonical fixture. D1 manages its internal metadata table.

The workflow preserves logical equivalence evidence in `canonical-snapshot/snapshot-proof.json`
and the conservative one-pair and 30-pair estimates in `canonical-snapshot/probe.json`.
Check both before considering the disposable comparator for a hosted experiment. The file sizes
describe the two offline databases. Physical layout and hosted latency need separate observations.

### Restore the fully populated Transaction fixture

Select `--materialized` and supply the same private `--canonical-fixture` to `cells/prepare.py`
to restore the complete pre-Login D1 fixture. The source replays the pinned Alchemy migrations
and the established eight-original fixture with active production constraints and triggers.
The unmounted destination copies the schema and all application rows, installs the exact triggers
in source order, and verifies schema, row identities, stored values and foreign keys before any
Worker receives a request. Its Session and Audit tables must be empty before genuine Login.

The workflow retains the materialized run's `snapshot-proof.json`, `probe.json`,
`refusal.json`, `manifest.json` and `limits.json` in the `materialized/` evidence directory.
`snapshot-proof.json` records the source and restored state. `probe.json` includes
complete response checks, bounded per-batch usage and one-pair and 30-pair ceilings. Use the
exact fixture and bundle from the protected experiment when obtaining account admission.
Individual hosted SourceAttestation identity and independent resource cleanup still require
their own protected observations.

### Obtain the closed native Transaction fixture receipt

The eight-original Transaction history comparison covers that financial view only. The browser,
Budget, Recurring and Needs Review comparisons require their own fixture parity and observations.
The protected Transaction comparison requires a tracked receipt-capable native revision on the
closed acceptance hosts. The release builder adds one Core signing secret, its public-key fingerprint and the verified
closed provider revision when the protected release selects `transaction_fixture_signer`.
The ordinary inventory keeps its original exact binding set. The candidate inventory requires
`NATIVE_FIXTURE_SIGNING_KEY` as a Core secret and `NATIVE_FIXTURE_SIGNER_SHA256` as Core text
with the expected SHA-256 of the public key's SPKI DER. The builder verifies this against the
P-256 PKCS#8 private key. Configure the protected release secret as lowercase DER hex and pin
the fingerprint independently. The comparator receives only the public SPKI DER hex as
`FIDY_NATIVE_FIXTURE_PUBLIC_KEY` and the existing closed-request `SMOKE_PROOF`.

Use the **Release native application** workflow on protected trunk to prepare both Worker builds
from the same commit. Keep ordinary admission closed and the hosts set to acceptance.

1. Select `plan-fixture-fallback` and enable `transaction_fixture_signer`. Review the resulting
   `native-fixture-plan-<run-id>` against current account headroom. The plan expects one new
   revision-scoped smoke Worker, Queue, Workflow and consumer. It identifies the original four
   smoke resources in Alchemy's deferred deletions. Their physical resources remain in service.
   The read-only operation records the proposed logical resource IDs and actions.
2. On that same SHA, select `prepare-fixture-fallback` with the signer enabled. This forward
   repair starts only from the recorded original deployment. The dormant UserStore runs without
   access to the receipt key. Ordinary financial reads and current-release admission continue
   through the real application. The runner checks the original private provider's exact deployment
   and version, the five SQLite namespace IDs, an ordered digest of each original User ID and complete financial history, and the candidate
   and mixed-pair smoke probes. It uploads `native-fixture-fallback-<run-id>` before moving traffic.
   Retain the artifact ID and independently pin its GitHub archive SHA-256.
3. Retain any interrupted stage and inspect its release and qualification outcomes before
   restoring it. The protected recovery operation admits only the independently qualified stage
   described below.
4. With the dormant release verified, run `rollout` on the **same trunk SHA** with the signer enabled.
   The active Ingress and Core are separate compiled artifacts. They reuse all four prepared smoke
   resources, the original provider, the signer, the five SQLite namespaces and the closed hosts.
   The normal code-only rollback checks now compare the active builds with the previously serving
   dormant builds. Both original Users must still authenticate and read their financial history.

When the pinned original upload succeeded and staging failed before either candidate served,
use `plan-fixture-repair` on the repair commit with the signer enabled. The protected job
authenticates the source run, archive, original deployments and financial control digest.
Review the plan for reuse of the four previously created smoke resources. On that same
revision, `resume-fixture-upload` captures the current stable pair and revalidates the
installation before uploading replacement Core and Ingress versions and updating the existing
Smoke executor to their revision. The Queue, Workflow and consumer keep their original identities.
The sealed stage records the new Smoke version and deployment for the forward recovery checks. The
one-off workflow checks ancestry from the reviewed repair and permits only its listed verifier changes.
The signed workflow builds the retained Web revision before planning so Alchemy can compare its local
output with the recorded Build. The read-only inventory records qualification or refusal and never applies a change.

When the repair has staged the pinned Core and Ingress at zero traffic and stopped during
qualification, use `reseal-fixture-fallback` with the signer enabled on protected trunk.
The workflow authenticates both failed source runs, their immutable archives and the original
User controls. It checks the verifier's complete Git tree against the staged build, records
the actual verifier SHA separately and keeps the application release SHA on the staged Workers.
It rechecks the exact stable and candidate deployments before and after qualification. A
successful run publishes a `native-fixture-fallback-<run-id>` stage archive and leaves
routing at its original percentages. Preserve the archive ID and independently pin its SHA-256.

To promote the qualified dormant pair, dispatch `recover-fixture-fallback` separately with
the signer, stage artifact ID and archive digest. Recovery requires a successful protected
reseal and freshly verifies the original coordinates. After dormant verification passes,
a separate signed `rollout` can upload and exercise the active pair. Each dispatch checks that
its protected verifier descends from the staged revision and changes only reviewed verifier
files. The cohort workflow accepts the resulting active rollout evidence after independently
checking that lineage, promotion and installed verification.

The original private fixture Worker owns the synthetic OIDC and payment identities. Current OAuth
flows use fresh pairing state, nonce, PKCE and authorization codes against that retained provider.
HTTP request proofs, technical smoke Queue and Workflow delivery, receipt signatures and background
leases remain bound to the current application revision. The initial forward repair's stage artifact
and the final promoted rollout's qualification artifact serve different operations.

Use the **Measure the closed native Transaction cohort** protected workflow on trunk. Provide a
new random comparison prefix, the installed SHA, the two serving version UUIDs, and the artifact
ID and separately pinned archive SHA-256 from that release's successful protected rollout.
The rollout must contain its tested rollback receipt and full native verification. The job compares
those records with the live deployment identities of all five Workers, the closed host, the Core
signer fingerprint and UserStore namespace. It uses the existing protected smoke proof and
`FIDY_NATIVE_FIXTURE_PUBLIC_KEY` public environment variable. Select one or thirty isolated pairs.
The workflow builds the frozen comparator on the private runner and checks the independently
calibrated ceiling of 18,194 D1 rows read and 4,754 written.

The native owner shares the production-deployment concurrency group. Before enrolling, it
requires two existing smoke User logins, a refused login for the unused performance subject,
no existing one-use marker and a complete physical census. For this eight-original native
experiment it caps the account delta at 750,000 SQLite reads and 30,000 writes. That includes
250,000 reads and 10,000 writes held for cleanup, in addition to the standing production
reserve. Other native workloads retain their own calibrated ceilings. It checks fresh account-wide SQLite
analytics and a rolling 31-day R2 usage window. The R2 check reconciles counts by action to
the account total. It charges every action except `GetObject` against the Class A limit and
the entire total against the Class B limit. It sums maximum observed payload and metadata
sizes for each bucket. [R2 operation classes and allowances](https://developers.cloudflare.com/r2/pricing/)
It holds 4,096 operations and one MiB for the experiment. These are conservative headroom checks.
Cloudflare analytics and settlement can lag. [R2 account datasets](https://developers.cloudflare.com/r2/platform/metrics-analytics/)

The native custody object in the existing private release-smoke bucket is
`protected-storage/account/<account-id>/performance-1/<native-revision>.json`. The runner derives
separate credentials for conditional ledger updates and a read-only lookup of the exact receipt
marker. It records intent before dispatch, including before every timed native read. Sessions,
fixture evidence and the D1 package stay on the runner. After the comparison it admits ordinary
erasure for that exact performance User, independently observes an absent or empty UserStore,
checks the former Session or an expired ungranted login, and signs in both original smoke Users.
The revision's one-use issuance marker contains the random prefix and stays in place. Shared
background leases expire normally.

After an interruption, select **cleanup** with the identical prefix, revisions and rollout
artifact. A different runner waits for the 20-minute foreground lease and 90-second in-flight
grace to expire. The independent runner can recover from the private account ledger without a
local Session or signup. An ambiguous identity, unexpected physical object or unreconciled cost
stays fenced. After UTC rollover only one separately metered cleanup reservation is available.
Its evidence marks the original accounting day incomplete. D1 infrastructure recovery remains
the responsibility of the comparator owner's `cleanup` command above.

The candidate verifier checks the acceptance hostname, actual
deployments, version bindings and signer fingerprint from the account. It uses the fixed
performance-1 provider identity, retains the original bound Session, captures eight originals
through the atomic API, links the known pair, and inspects all eight Transactions. An ambiguous
offering fences the next mutation. The owner rechecks the original Session's live consent and
erasure fence, Google credential, requested fixture and Session Audit. The response signs and
encrypts the minimum required source and link evidence, binding it to the revision, resource
prefix, Session digest and canonical manifest digest. A conditional create under
`_release-smoke/<revision>/acceptance/transactions/performance-1` allows one issuance.

Provide `$PRIVATE_NATIVE_RUN/fixture` to `cells/prepare.py --materialized --canonical-fixture`.
Check the captured coordinates and digests independently before creating the disposable D1 graph.
The already installed revision has its own qualification record. Any new candidate needs its own
verified installation, resource observations and native usage bounds.

The credential-free command `rehearse_cohort.py --out <private-directory>` reopens persistent workerd
from a fresh controller after receipt issuance and verifies physical erasure and both survivor identities.
The command `hosted.py rehearse --out <private-directory>` runs the same
closed provider, Ingress, Core and SQLite owners on workerd. Its temporary verifier credentials
are private to that rehearsal. Upload only `summary.json`, which contains counts and digests.

The protected closed rollout records the stable Core and Ingress version IDs and revision before
upload. A signer candidate can promote only if the established compatibility policy permits
return to that exact tested pair. Adding the two signer bindings to a previously unsigned Core
changes its binding inventory and fails that precondition. The ordinary first-install target
also requires an empty, explicitly named installation. Its fixed hostnames, stack and Worker
names prevent it from acting as a second independent installation on the same account. Keep
the incumbent release and its erasure/fleet qualifications in place while this remains true.
