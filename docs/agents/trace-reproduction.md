# Reproducing a failure from selective telemetry

Fidy records bounded operational metadata so an agent can locate a failing execution and build a
synthetic regression. A trace is evidence about execution, not an exact runtime recording or a
guarantee that every failure can be reproduced. Do not collect request bodies, financial facts,
credentials, User identifiers, provider payloads, prompts, replies, DOM snapshots or screen recordings.

## Evidence to collect

For a failed API call, use the server-authored `Fidy-Trace-Id` response header. Browser transport
diagnostics include the validated receipt when a response reached the browser. Search Cloudflare
custom Worker logs for that trace ID, retaining only the closed span/failure/Work envelopes defined
in `apps/server/cloudflare/runtime/telemetry/contract.ts` and the observability contract. Platform log
timestamps establish chronology; parent span IDs establish causality. Trace IDs are diagnostic
coordinates, never credentials or authority to retrieve another User's data.

Collect the deployed Git revision, operation, safe error code, terminal outcome, status class,
latency, attempt, bounded breadcrumbs and model token usage when supplied. Identify missing parents
and unknown releases explicitly. Public ingress creates fresh local traces and replaces caller
claims; only Fidy's private service bindings and durable envelopes continue them. Invalid or expired
continuation starts a fresh trace without refusing the underlying work. Provider callbacks begin
new traces. Trace headers never travel to external providers.

Browser runtime/render/schema failures are local bounded diagnostics. They do not send application
content to an ingestion endpoint. A request that never reaches the server has no server receipt;
use its local outcome and timing, and record that limit. A runtime or rendering failure does not
prove which server request caused it. Do not attribute it using an unrelated recent trace.

## Agent investigation

1. Inspect the exact release revision and required architecture, coding and security standards.
   Start at the named operation and failing boundary. Read the relevant `.patterns` note and verify
   the selected upstream source before changing Effect, React or Cloudflare behavior.
2. Separate observed facts from hypotheses. An HTTP 2xx means transport success, not necessarily
   successful model interpretation, payment settlement or durable completion. An interrupted local
   request does not prove that a remote mutation was rejected. Do not repeat a production mutation
   to investigate an ambiguous outcome.
3. Turn the hypothesis into a synthetic scenario: fixture domain state, explicit authority,
   provider status/failure, clock/deadline, concurrency and retry schedule. Use owner-published
   interfaces. Do not retrieve real financial content or substitute retained Audit or Transcript
   data for diagnostic telemetry.
4. Write a failing regression at the smallest meaningful seam. Durable queues, D1 atomicity,
   coordinator serialization and Workflows require the native adapter tests; a pure mock cannot
   prove their behavior. Assert safe classifications, cancellation, retry/ack behavior, and privacy.
5. Apply the fix, demonstrate the regression passing, and run the affected verification groups.
   Report the trace facts that motivated the test, the hypothesis it proves, and any uncertainty
   the available evidence cannot resolve.

When input semantics or exact model/provider content determine a failure, telemetry alone is
insufficient. Ask for an authorized synthetic example or use existing approved regression fixtures;
do not widen logging to recover the missing content.

## Cost and lifecycle

The exporter emits structured custom logs synchronously and keeps only bounded active-span state.
There is no background upload buffer or full execution replay. Telemetry failure must preserve the
application's original result and interruption. Active-span and breadcrumb bounds are executable
adapter tests. Browser defect storms are capped per page lifetime. Cloudflare custom-log persistence
is configured by infrastructure; platform retention, availability and delivery are deployment
properties, not guarantees made by the application.

Tests establish projection and bounds; live deployment is still required to establish actual log
availability, end-to-end capture and workload overhead. Do not claim that metadata-only recording
has zero cost, or that local tests establish production performance.
