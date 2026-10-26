# Temporary review-return comparison

Remove the `Temporary exact-revision review-return ABBA` CI step, its
`review-return-abba/**` artifact path and this document after the first complete
comparison is inspected, before merging PR #1553. They are diagnostic-only.

The step is restricted to PR #1553, browser shard 1 and run attempt 1. It runs only
when the published PR-head commit subject contains `[review-return-abba]`.
Do not put that marker in later commits. Reruns do not repeat this protocol.

The predeclared same-runner order is A1, B1, B2, A2:

- A: `d73208c3e19585d854b032faa4b735924aceda20` (Settings native-clock baseline).
- B: `86ed753df11fdd240792f6bf3ec2dc8f73738184` (Subscription native-clock head).

Each invocation uses the exact revision's frozen dependencies and existing
production Playwright harness. A new harness process acquires isolated D1 and
browser contexts, with a fresh native-image cache. The original Review return
from Transactions and stable Budget-return control retain their 10ms assertions.
Admission dependencies remain selected. Every invocation is retained even when
an earlier original gate fails; any nonzero result fails the diagnostic step.
Normal required checks, permissions, triggers, secrets and retry policy are unchanged.
The diagnostic has a 15-minute overall bound and 3-minute per-invocation bound.

The existing browser artifact stores `plan.tsv`, `results.tsv`, install/output
logs and each invocation's JSON reporter under `review-return-abba/`. The reporter's
supported `PLAYWRIGHT_JSON_OUTPUT_FILE` override keeps normal timing evidence intact.
No real account or production data is used.

Two originals per revision are limited evidence: a consistent head-only shift is
useful, but overlapping/mixed results remain inconclusive. Never select a passing
repeat to replace a failure. Traced post-failure replays remain warmer diagnostics,
not original gate measurements or source-level CPU profiles.
