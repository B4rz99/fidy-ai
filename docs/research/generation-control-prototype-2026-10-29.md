# Generation control performance prototype, 2026-10-29

The complete-handler experiment does not support replacing the production R2 authority yet.
A faster isolated lookup did not establish the required twofold improvement across the handler.
The production authority, deletion and restore protocols remain unchanged.

The private prototype ran the actual Core Categories handler against its own synthetic D1 and
R2 resources. The alternative returned the synthetic generation through a fresh SQLite Durable
Object RPC for each guarded database unit. Each mode retained three generation checks and three
native database batches. No publication, invalidation or crash-recovery protocol was implemented;
this is performance evidence only, not a deployable authority implementation.

Twelve counterbalanced bursts each made eight reads through the current two-transfer browser
policy. All 96 final responses were HTTP 200, without resource refusals. Median burst time was
1,698.5 ms for R2 and 1,308.5 ms for RPC: **1.30×**. Nearest-rank p95 over six bursts per mode was
2,460 ms versus 1,671 ms: **1.47×**, with a sample too small for a strong tail claim.
Database phase medians remained about 60–70 ms. Generation phase medians varied by block;
the experiment did not capture enough placement information to explain that variation.

The initial experiment lost its result to a client error. Added boundary observations then
identified the controller's 50-subrequest limit: the first 50 reads succeeded, and subsequent
attempts failed locally. Increasing the private controller limit was rejected on the Free plan.
The completed experiment instead used three Workflow invocations, four bursts each, preserving
the counterbalanced order without changing account billing or production limits.

The raw successful run, rejected and failed runs, cleanup repair and harness sources are retained
in [the proof JSON](generation-control-prototype-proof-2026-10-29.json). Zero-duration failed
attempts in the interrupted experiment are not latency samples. CPU and memory gains were not
established. The next read-path investigation should reduce serial native units while retaining
atomic live authority, Audit, admission and recovery-generation checks.

References: [Workers limits configuration](https://developers.cloudflare.com/workers/wrangler/configuration/#limits),
[Durable Object class lifecycle](https://developers.cloudflare.com/durable-objects/reference/durable-objects-migrations/).
