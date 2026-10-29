# Canonical browser transfer budget — 2026-10-29

Eight independent canonical reads previously started together. The server admits at most two
concurrent canonical requests for a User; refused reads then retried in waves. Each generated
canonical browser client now allows two active transfers, including complete bounded body
materialization. Queue time shares the existing deadline, queued cancellation removes work, and
backoff releases capacity. Server admission, fresh session checks and recovery fencing still run.

## Controlled hosted result

[Raw evidence and executable harness sources](hosted-browser-burst-proof-2026-10-29.json) contain
12 counterbalanced ABBA bursts, eight logical reads each, on native Cloudflare Workflows/D1/R2.
Both policies use the production Core handler at `6e72d670e5919aa36d5bf4d3edaeab3011bcd841`.
Each burst has its own synthetic User, bound session and consumed pairing. The private fixture
installs production migrations and only reads the global 16-category taxonomy. It has no financial
data or provider credentials. Injected Fetch calls the handler directly: browser internet RTT and
cross-Worker HTTP routing are excluded. All 96 primary-run final responses were 200.

| Measurement                            | Previous | Two transfers |            Improvement |
| -------------------------------------- | -------: | ------------: | ---------------------: |
| Median burst completion                | 4,297 ms |      1,506 ms |                  2.85× |
| p95 burst completion                   | 4,652 ms |      1,797 ms |                  2.59× |
| p95 individual completion within burst | 4,461 ms |      1,615 ms |                  2.76× |
| Network attempts for 48 logical reads  |      109 |            48 |            2.27× fewer |
| Native D1 batches                      |      327 |           144 |            2.27× fewer |
| Native R2 reads                        |      327 |           144 |            2.27× fewer |
| Resource refusals                      |       61 |             0 | Eliminated in this run |
| Peak transfers                         |        8 |             2 |               4× lower |

Every paired burst exceeded 2×, with ratios 2.28–3.40×. The p95 estimate has only six bursts per
policy. Earlier setup failures and a complete exploratory run are retained in the evidence; the
exploratory control had two unavailable responses. The primary run records every final HTTP code.
This does not prove standalone category latency, actual Worker CPU/heap, invoice savings, or Queue
enqueue-to-completion p95. The browser limit is local to a client; other clients and tabs still share
server admission. This is not a global throughput cap or a replacement for durable admission.

## Other hypotheses checked

The production paced category baseline remained about 520 ms median, below the desired 2× gain
against the original 576 ms baseline. Native local V8 profiling ran 500 production-handler reads
against synthetic native D1/R2: all returned 200, with a 2 ms wall median and three fresh R2 checks
plus three D1 batches per read. The short production CPU capture showed GC/idle samples and was
inconclusive; it does not identify an application CPU bottleneck.

A private Workflow compared 24 counterbalanced pairs of reads of the existing operational
`recovery/generation` key. GET median was 75.5 ms; HEAD was 71.5 ms, only 1.06× faster. No object
changed and no object contents were exported. [Cloudflare documents both operations as strongly
consistent](https://developers.cloudflare.com/r2/reference/consistency/). The small difference does
not justify changing the recovery protocol.

Explicit placement near the ENAM primary was also rejected: the actual targeted-version block
slowed to roughly 600–800 ms and stopped on a 429. That does not establish placement caused the
refusal. A superficially faster earlier block still used the original version in MIA and was not a
confirmed treatment. Original default placement and the original deployed version were restored
and health checked before this patch. No placement change is in the PR.

## Validation and release

The burst regression initially failed with eight active transfers where two were expected. The
new tests cover burst completion, queued interruption, original-deadline expiry without dispatch,
full body ownership, and capacity during retry pacing. All 319 web tests, web typecheck, typed lint
and dependency graph checks passed locally. Native resource cleanup is independently checked in
[browser-burst-cleanup-2026-10-29.json](browser-burst-cleanup-2026-10-29.json).

The body-parser temporary exception expired during this work. The normal seven-day-age installer
accepted fixed 2.4.0; the acceptance and exact scanner exclusion were removed. The dependency-policy
check also required the newly eligible bun-types 1.4.4 pins. CI and production release verification
remain the final release gates.
