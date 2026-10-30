# Core placement and the remaining production target

**Production trial rejected.** Smart Placement reported `SUCCESS`, but the measured Category median
increased from 260.5 to 359.1 ms (37.9% slower). Default execution must be restored and retained in
subsequent releases. The implementation and controls below record the historical trial, not a
recommendation to re-enable it. See the [full production evidence](core-placement-production-2026-10-30.json).

PR #1617 deployed revision `11000495fe` successfully. The matched production Category cohort
improved median 542.3 to 292.8 ms (**1.85×**) and observed maximum 1,206.2 to 823.8 ms
(**1.46×**). The production 2× target remains open. Both six-read cohorts returned the same
16 Categories, 1,086 bytes and identical wire/normalized hashes; one predeclared warmup per
cohort is retained separately. These small sequential observations do not establish p95,
CPU, memory, total billing or an app-wide gain. See the
[complete comparison](browser-category-production-comparison-2026-10-30.json).

## Proposed change

The trial enabled Smart Placement only on the private Core Worker, whose fetch handler performs the
R2 generation lookup and D1 work. Keep Ingress and static assets at their existing locations.
Placement changes where code executes; it does not remove authorization, Consent, admission,
Audit, fresh recovery fencing or any SQL transaction boundary.

Cloudflare's [placement documentation](https://developers.cloudflare.com/workers/configuration/placement/)
says Smart Placement is available on all Workers plans and may need up to 15 minutes to analyze
traffic. It affects fetch handlers, not named RPC entrypoints or scheduled work. Its candidate
locations are limited to locations where the Worker has run; insufficient traffic can prevent
optimization. Configured mode is therefore not evidence of a latency improvement. The account
must remain Free, and no performance result is claimed for this candidate yet.

## Native API controls

Three bounded controls ran against sequential instances of one disposable Worker, with no
storage or service bindings, public routes or application data. Controls two and three included
one plain-text test binding. All instances were deleted and independently returned 404. No D1
SQL or schema work was performed. The sanitized observations are in the
[native control summary](core-placement-native-control-2026-10-30.json).

1. `PATCH /scripts/{name}/settings` with multipart `settings` containing placement created and
   activated a new version, kept the code ETag, and dropped the omitted annotation tag. This is
   unsuitable as an unnoticed mutation inside the release's read-only capture or staging gates.
2. Uploading a version without placement and promoting it reset placement to default. Setting
   placement on the previous live version alone would not persist through normal releases.
3. `POST /scripts/{name}/versions` accepted `metadata.placement: {mode: "smart"}`. The staged
   version's immutable resources reported Smart Placement while the active version ID stayed
   unchanged. Promotion then activated that configuration. The code ETag and test binding were
   preserved. `GET /settings` already described the uploaded candidate before promotion, so it
   cannot prove the active or intended candidate version's configuration by itself.

The [script-only settings API](https://developers.cloudflare.com/api/resources/workers/subresources/scripts/subresources/settings/methods/edit/)
does not include placement. The
[combined settings API](https://developers.cloudflare.com/api/resources/workers/subresources/scripts/subresources/script_and_version_settings/methods/edit/)
includes placement and documents annotation inheritance behavior. The version upload behavior
above was verified on the provider on 30 October 2026 UTC, rather than inferred from a shared
SDK metadata type.

## Deployment boundary

The installed, integrity-locked Alchemy beta.80 source exposes the placement input but omits it
from its self-rollout version-upload metadata. The retained patch now forwards it in both the
published TypeScript source and compiled JavaScript. Its other ten existing patch sections are
unchanged. The patch was rebuilt against the npm tarball whose SHA-512 integrity matches the lock;
Bun's local package marker is excluded. The source manifest records the new patch digest.

The trial declared Core's desired mode in the runtime topology and verifies it on the exact
uploaded Core version before staging could continue. Missing, default or foreign-version responses
refuse promotion. An `INSUFFICIENT_INVOCATIONS` status may still pass this configuration gate;
optimized placement and performance require separate observation after deployment. No direct
settings patch, early promotion, new data resource, credential or billing upgrade is needed.

## Production rejection and restoration

PR #1624 merged as `c5c9b43b0f`; production run `41010737657` passed its exact-pair gates,
normal traffic probes, topology, public discovery and drift checks. The active Core version
`23c5b9fb-94f5-49d3-bc8b-be8ebca81f36` reported Smart Placement and service status `SUCCESS`.

Three retained pre-placement controls had medians 243.05 ms (eight reads, `6bde98fb6a`),
285.10 ms (eight reads, `8a16adf5cd`) and 260.50 ms (three reads, `c57d38769f`). The shorter
final control followed concurrent Recurring and Dashboard releases and immediately preceded the
placement merge; their Category implementation was unchanged. The paired Smart Placement cohort
had eight measured reads with median 359.10 ms and maximum 912.80 ms. Each cohort retained one
excluded warmup. Every request succeeded with the same 16 Categories, 1,086 bytes and matching
wire/normalized hashes. The negative result is retained; it does not support a latency gain.

The original production experiment ceilings remain 5,000 writes and 100,000 reads. Its request
plan carried all 47 original reservations forward and admitted at most 86 owned requests total.
The protected-read upper bound is 78, conservatively charged 64 writes each (4,992); new public
health identities perform no storage work. Reads are reserved at 86,000. No further protected
production cohort is admitted under this experiment. Account observations include all databases,
including deleted experiments, and preserve 50,000 writes and 2.5 million reads for production.
These are conservative reservations, not per-request measured production D1 costs.

Restore the prior captured Worker pair through the guarded rollback workflow, then remove Core's
placement input so later uploads retain default execution. The prior native promotion control
already established that an omitted placement produces an immutable version without `placement`
or `placement_mode`; promotion restores empty live settings. Staging now requires precisely that
native default representation on the exact candidate. Smart/targeted placement and foreign-version
responses refuse promotion. Keep the Alchemy forwarding correction and all trial evidence.

A retrospective provider metrics read returned seven estimated invocations in each six-request
snapshot window. Shared-isolate memory was higher in the later window, and CPU quantiles were
lower, but the windows cannot establish workload-specific CPU/memory gains or causal regressions.
Local synthetic profiling likewise does not establish deployed resource improvements. #1589
remains open; billing, memory, CPU, maximum capacity and universal 2× gains remain unproven.

Guarded rollback run `41012633170` failed with a generic release-routing error. Independent
inspection still found the Smart version serving 100% of traffic. The attempt was not retried;
default execution is instead restored through the normal validated forward-release path.
