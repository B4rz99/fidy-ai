# Hosted MCP CPU investigation on Workers Free

Research date: 2026-10-07. Baseline release: `ccf2f6baf3476d4830b88d254eeea44de19fb5d4`
(PRs #1077 and #1079). Scope: identify the CPU bottleneck and prove a Free-compatible
execution path. This note does not establish that all application workloads fit the Free plan.

## Established failure and remaining uncertainty

The private, metadata-only `production-evidence.json` from the authorized synthetic Production
journey records successful native Codex OAuth, four tools, sensitive confirmation, and natural
refresh. Claude Code OAuth also succeeded, but its tool journey failed. The corresponding Core
invocations reported `exceededCpu`; later repeated requests terminated at 10 ms. This identifies
the immediate platform failure. It does **not** identify the expensive function, prove that Claude
itself causes the cost, or establish the account billing plan. The settings read returned
`limits: null`, `usage_model: standard`; the billing read returned 403.

Workers Free has a 10 ms CPU allowance per HTTP request. Waiting for network and database I/O
does not consume that allowance. The runtime permits occasional overruns before terminating
consistently expensive execution. Therefore a successful request is insufficient evidence that
its code fits the allowance. [Workers limits](https://developers.cloudflare.com/workers/platform/limits/#cpu-time)

Cloudflare's CPU metrics documentation explicitly describes rollover from requests below the
limit. This explains why mixed successes and failures are possible; it does not prove that
rollover caused the difference between the two clients in this incident.
[CPU time metrics](https://developers.cloudflare.com/workers/observability/metrics-and-analytics/#cpu-time-per-execution)

## Measure CPU with the right instrument

Production `performance.now()` and `Date.now()` advance only after I/O. A synchronous expensive
operation can show a zero timestamp delta; wrapping a database call measures elapsed I/O rather
than that function's active CPU. Local timers behave differently. Consequently new stage-duration
logs can locate a stalled phase but must not be reported as CPU attribution.
[Performance and timers](https://developers.cloudflare.com/workers/runtime-apis/performance/)

Cloudflare recommends local DevTools CPU profiling and production-like requests. Use the pinned
workerd/Miniflare harness, production bundle settings, compatibility flags, native D1 bindings,
synthetic seeded state, and the same MCP protocol messages. Capture cold and warm requests
separately. A local profile locates expensive functions and allocation/GC; different hardware,
JIT state, instrumentation and I/O mean it cannot certify the deployed 10 ms allowance.
[Profiling CPU usage](https://developers.cloudflare.com/workers/observability/dev-tools/cpu-usage/)

Installed source authority is Miniflare `5.20260911.1-alpha`, not an assumed older API:

- `node_modules/miniflare/dist/src/index.d.ts` exposes `inspectorPort` and `getInspectorURL()`.
- `node_modules/miniflare/dist/src/index.js` implements `/json` and `/json/list`, returning a
  separate `webSocketDebuggerUrl` and title for each Worker. Select **Core**, not ingress.
- The inspector proxy rejects unexpected Host/Origin values. Keep the inspector on loopback;
  use an ordinary loopback WebSocket client and no production authentication material.

Concrete capture procedure:

1. Enable a loopback `inspectorPort` in the existing local multi-Worker harness; await readiness.
2. Read `/json/list` and select Core's exact debugger target. Save a profile of the unchanged
   baseline before editing code.
3. Connect to that target, run `Profiler.enable`, optionally `Profiler.setSamplingInterval`,
   then `Profiler.start`. Check every protocol response for errors; do not assume the installed
   workerd implements every current CDP method.
4. Issue one labeled protocol phase at a time: initialize, initialized notification, tools/list,
   categories read, budget create, two-child atomic batch, sensitive budget deletion. Consume
   response bodies and preserve real session lifetime/cancellation semantics.
5. Run `Profiler.stop`, retain the returned `.cpuprofile` privately, and compare sampled stacks
   for layer construction, route/schema compilation, application execution, encoding and GC.
   Repeat warm phases to collect enough samples. Include idle/control captures; elapsed profile
   time and idle samples are not active request CPU.
6. Repeat the identical sequence on the candidate. Report attribution and counts alongside
   sampled reductions, not a local timing assertion disguised as a production CPU guarantee.

The commands and profile format are owned by the
[Chrome DevTools Profiler protocol](https://chromedevtools.github.io/devtools-protocol/tot/Profiler/).

## Observe the failure even when application logging stops

Capture ingress and Core platform invocation outcomes separately. A terminated Worker may not
reach application finalizers or emit its final log; a generic ingress 503 alone cannot distinguish
CPU termination from another backend failure. Cloudflare documents 1102 as CPU exhaustion,
and `passThroughOnException()` does not mitigate resource-limit failures.
[Errors](https://developers.cloudflare.com/workers/observability/errors/),
[Execution context](https://developers.cloudflare.com/workers/runtime-apis/context/)

Real-time tails are immediate and may be sampled at high traffic. Their request headers can
contain credentials: raw tails belong in restricted private storage, not committed evidence.
Publish only method, canonical route family, exact deployed version, outcome, CPU/wall figures,
and allowlisted operation/status metadata. Never publish OAuth callback URLs, authorization
headers, tokens, pairing verifiers, request bodies or financial facts.
[Real-time logs](https://developers.cloudflare.com/workers/observability/logs/real-time-logs/)

The installed Workers types distinguish `exceededCpu`, `canceled`, `exceededWallTime`, and
`responseStreamDisconnected`, and expose `cpuTime` and `wallTime` in trace outcomes. Preserve
those distinctions rather than relabeling all unavailable responses as CPU failures.
Platform spans also expose invocation/version metadata and outcome.
[Span attributes](https://developers.cloudflare.com/workers/observability/traces/spans-and-attributes/)

## Proposed acceptance evidence

Run a bounded synthetic request sequence before and after the change against the same account
and exact deployment version, with no billing or limit change. Separate cold initialization,
session setup, warm reads, mutations, atomic batch and sensitive confirmation. Record how many
requests were attempted, observed and sampled; report all failures, not just passing calls.
Use actual platform CPU figures where available, not HTTP latency or application timers.

Require both real hosts to complete the tool journey and natural refresh, canonical audit/state
checks, first-party revocation, negative post-revocation checks, and fixture cleanup. Repeat warm
requests so the result does not rely on a single tolerated burst. Keep fresh authorization/session
checks on every request: sharing static router/schema construction must not cache a User, grant,
permissions, binding credentials, request scope or mutable transaction state.

If profiling shows the current CPU envelope cannot be met with a focused implementation fix,
SQLite-backed Durable Objects are documented as available on Free with a different, 30-second
default CPU envelope. Moving execution there would be an architectural option requiring its own
security, lifecycle, quota and regression assessment; it is not proof that the current Core Worker
has that allowance. [Durable Object limits](https://developers.cloudflare.com/durable-objects/platform/limits/)

## Measured cause and candidate change

The 2026 adapter previously ran `McpServer.layerHttp`, catalog projection, registration and
response encoding in Core for every request. The 2025 adapter already ran in the per-User Durable
Object. This routing distinction is explicit in the baseline `cloudflare/mcp/runtime.ts`;
it must not be attributed to the host name. Native Production proof remains the acceptance gate.

A temporary public ingress/Core/D1 harness reproduced expensive repeated `tools/list` requests.
Bun's process profiler located schema reflection and `SchemaAST.isTree`; its CPU totals include
the harness and are not Worker CPU. A second harness bundled the real `handleMcpRequest` into
Miniflare/workerd with compatibility date `2026-09-08`, an isolated native D1 snapshot of genuine
synthetic OAuth fixture rows and real MCP 2026 metadata. The snapshot retained table definitions
and rows, but omitted migration triggers/indexes; it profiles authentication/discovery, not
migration or mutation correctness. The production entrypoint and deployment bundle still require
Production measurement. Each profile covered nine warm requests after three unprofiled requests,
consuming each JSON response. CDP samples were aggregated excluding `(idle)` and `(program)`;
GC is included. These sampled estimates are neither platform accounting nor precise per-request
CPU limits.

| Workerd experiment                                                 | Nine requests, sampled active ms | Mean ms/request | `isTree` self ms |
| ------------------------------------------------------------------ | -------------------------------: | --------------: | ---------------: |
| Uncached baseline                                                  |                          1260.26 |          140.03 |           377.38 |
| Cache only immutable catalog metadata                              |                           690.06 |           76.67 |           343.03 |
| Candidate Core authentication/handoff, synthetic coordinator reply |                            13.58 |            1.51 |                0 |

The cache-only experiment falsifies the claim that schema reflection alone explains the cost.
It removes almost half the sampled work, while repeated JSON-tree validation remains dominant.
Installed Effect 4.0.0 source shows `McpServer.addTool` constructs an `McpTool` descriptor from each
registered tool, and tool/list codecs include JSON-valued input/output schemas. `SchemaAST.isTree`
walks their object graphs with a new validation cache per invocation. Caching the projected catalog
does not eliminate SDK descriptor/response validation. No upstream dependency is patched and no
boundary validation is disabled.

The candidate therefore moves all MCP SDK execution into the existing SQLite User Durable Object,
which already owns bounded protocol lifetime, request-private callback admission, cancellation,
capacity and cleanup. Both supported adapters are configured there. Sessionless 2026 replies do
not become persistent sessions: owners without an issued session retire after the leased reply.
The only shared cache contains static catalog/tool metadata keyed by the validated finite scope
set (at most seven combinations). Every ingress admission, resident request and tool callback
still rechecks live authority; no User, credential, grant or Consent decision is cached.

The Core-only experiment uses a synthetic coordinator response deliberately: it measures the
remaining Core work and says nothing about DO invocation accounting. A public ingress regression
went red with zero User-boundary handoffs and green with two successful sessionless discoveries
and two handoffs. The focused OAuth ingress/native residency suite passed 61 tests. Existing
metadata-only Work observations continue to cover the handoff; fatal CPU termination is diagnosed
through platform outcomes rather than a new public error containing private causes.

Production acceptance is still pending for this candidate. Record exact deployed versions,
repeat requests, both real host journeys, platform CPU outcomes and cleanup before declaring the
Free-tier incident resolved.
