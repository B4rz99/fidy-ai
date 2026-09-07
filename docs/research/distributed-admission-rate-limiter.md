# Distributed admission and Effect RateLimiter — #470

## Scope and conclusion

Audit of server source at `8e01a87b28d31c2cc440f0b0ce02cc78b905639e`, with executable evidence
added by this issue. This supersedes the admission portion of the #459
[baseline inventory](../architecture/durable-execution-inventory.md).

**Retain PostgreSQL admission; adopt no RateLimiter store.** Effect RC.112 has no SQL
RateLimiter store. The Redis store cannot join a PostgreSQL transaction, atomically consume
several policy keys through `consume`, or reproduce the existing rolling logs and
calendar-aligned counters at their current limits. A custom SQL/Lua adapter would retain the
counter/lock/expiry machinery rather than delete it. The decision is
[ADR 0025](../adr/0025-retain-postgresql-admission.md).

This is not a rejection of Effect's durable execution facilities. SQL PersistedQueue and Cluster
remain the execution substrate under ADR 0024; their SQL stores do **not** implement RateLimiterStore.

## Classification

Paths below are relative to `apps/server/src/` unless prefixed `.repos/`. Each row names actual
counter-bearing controls, including counts derived from domain or evidence rows rather than a
counter column. Categories are mutually exclusive for this inventory:

- **P — per-process resource protection:** independent limits may multiply with replica count;
  restart loss does not grant domain authority. Includes request-local resource counters.
- **D — distributed rate limiting:** admission must coordinate processes and survive their restart,
  but commits independently of the subsequent domain transition.
- **T — transaction-coupled domain admission:** the decision or its accounting must share the
  proof, capacity, replay, entitlement, or domain transition's PostgreSQL commit.

Every D/T row rejects memory-backed RateLimiter. Every P row retains its existing concurrency or
resource bound, not a time-window substitute. Every D/T row retains PostgreSQL for the stated
reason. Several T controls are distributed too; T records the stronger requirement.

| Owner / counter                                                                                   | Class | Keys, semantics, and reason to retain                                                                                                                                                                                                                                                                                                                                                     | Source                                                                                                                                                                                                                                                   |
| ------------------------------------------------------------------------------------------------- | ----- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| BrowserLogin start/redemption lanes                                                               | P     | 8 starts / 4 redemptions concurrently per process; fail-fast semaphore, not tokens over time.                                                                                                                                                                                                                                                                                             | `shell/browser-login/handlers.ts:29-68,180-207`                                                                                                                                                                                                          |
| Browser-pairing email start/completion lanes                                                      | P     | In-flight proof-work protection; no replacement for persistent source/mailbox controls.                                                                                                                                                                                                                                                                                                   | `shell/email-authentication/authentication-handlers.ts`                                                                                                                                                                                                  |
| PATPairing start/claim lanes                                                                      | P     | 8 starts / 4 claims concurrently, cheap 503 rather than queued waiting.                                                                                                                                                                                                                                                                                                                   | `shell/tokens/pairing-handlers.ts:13-78`                                                                                                                                                                                                                 |
| Resend webhook signature/body lane                                                                | P     | Bounded concurrent exact-body authentication before persistence.                                                                                                                                                                                                                                                                                                                          | `shell/ingestion/resend-webhook.ts`                                                                                                                                                                                                                      |
| WhatsApp webhook body readers                                                                     | P     | 32 concurrent readers per process, independent of authenticated ingress budgets.                                                                                                                                                                                                                                                                                                          | `shell/channels/whatsapp/routes.ts:73-110,403-434`                                                                                                                                                                                                       |
| Hosted Turn round/tool/token counters; bounded parser rows/bytes and retry attempts               | P     | Per-attempt cost ceilings, not shared time windows. Preserve the limits and cancellation; durable retry ownership remains with #460–#468.                                                                                                                                                                                                                                                 | `shell/agent/agent-service.ts:1260-1304`, `shell/agent/hosted-inference.ts`, `core/ingestion/rules.ts`, `shell/ingestion/worker.ts`, `shell/email-authentication/delivery-retry.ts`                                                                      |
| BrowserLogin start log + live-pairing count                                                       | T     | SHA-256 of socket peer; 5 starts in any minute and 10 in any ten minutes, 10,000 live pending pairings. Charge only successful unique insertion, under nonblocking global transaction lock. A Redis decrement cannot roll back on collision or capacity failure.                                                                                                                          | `shell/browser-login/repo.ts:17-162`, `shell/browser-login/service.ts:109-135`                                                                                                                                                                           |
| BrowserLogin wrong-verifier count / polling interval                                              | T     | Pairing identity; wrong-proof terminalization and increasing poll delay live with the locked proof lifecycle, not a replenishable rate bucket.                                                                                                                                                                                                                                            | `shell/browser-login/service.ts:150-411`, `core/browser-login/rules.ts`                                                                                                                                                                                  |
| BrowserLogin approval rejection log count                                                         | T     | Stable User, five rejected approval audits in ten minutes, under approval lock; evidence remains append-only and must not become independent Redis state.                                                                                                                                                                                                                                 | `shell/browser-login/repo.ts:404-447`, `shell/audit/repo.ts`                                                                                                                                                                                             |
| Email delivery requester + recipient budgets                                                      | T     | HMAC of `user:UserId` or pre-User portfolio+BSUID caller, plus separately HMAC'd normalized recipient; five deliveries per first-use-anchored 24-hour window. Both budgets charge or neither does, with delivery generation publication. Not a sliding log despite the helper's “rolling” wording.                                                                                        | `shell/email-authentication/admission.ts:60-124`, `shell/onboarding/turn-transition.ts:287-335`, `shell/email-authentication/replacement-transition.ts`                                                                                                  |
| Email verification completion slots                                                               | T     | Four global locked rows; slots last for the verification transaction. Time-window tokens cannot bound simultaneous transactions or release with rollback.                                                                                                                                                                                                                                 | `shell/email-authentication/repo.ts:30-49`                                                                                                                                                                                                               |
| Email enrollment/authentication/replacement proof attempts, generation limits and resend cooldown | T     | Bound to the current enrollment/workflow and proof generation. Wrong attempts and cooldown advance with the authoritative security lifecycle; shared delivery budgets above additionally close recipient/caller bypass.                                                                                                                                                                   | `core/email-authentication/model.ts:90-125`, `shell/email-authentication/repo.ts`, `shell/email-authentication/browser-pairing-authentication.ts`, `shell/email-authentication/replacement-transition.ts`, `shell/onboarding/turn-transition.ts:243-335` |
| Browser-pairing email start admission scopes/attempts                                             | D     | HMAC mailbox + source + pairing. Atomic three-key charge: mailbox/pairing 5 per 24h, source 5/min and 10/10min; 150,000 retained-key ceiling. Independently commits before asynchronous start work. Redis single-key calls lose all-or-none charging and do not reproduce the rolling windows/key cap.                                                                                    | `shell/email-authentication/browser-pairing-authentication.ts:53-57,95-247`                                                                                                                                                                              |
| Browser-pairing email completion ingress scopes/attempts                                          | D     | Separate HMAC namespaces for source, pairing and unresolved address; source 5/min and 10/10min, other keys 5/10min. Atomic multi-key charge and same evidence-key capacity.                                                                                                                                                                                                               | `shell/email-authentication/browser-pairing-authentication.ts:250-295`                                                                                                                                                                                   |
| Browser-pairing email resolved completion-owner allowance                                         | D     | HMAC of stable User, 5/24h; one VerifiedEmailCredential per User means new pairings or credential evidence do not buy another owner allowance. Rolling history and shared evidence capacity would still require custom storage.                                                                                                                                                           | `shell/email-authentication/browser-pairing-authentication.ts:297-319`                                                                                                                                                                                   |
| PATPairing start log + live-state count                                                           | T     | SHA-256 of authoritative anonymous source; 5/min and 10/10min rolling windows, 10,000 live pending/approved pairings. Counter insertion and unique pairing insertion are one commit. Selected two-process proof below.                                                                                                                                                                    | `shell/tokens/pat-pairing.ts:150-184`, `shell/db/migrations/0035-pat-pairings.ts:147-194`                                                                                                                                                                |
| PATPairing claim-source log                                                                       | T     | Same source derivation, separate claim budget; 30/min and 120/10min. Counter participates in the claim transaction; a source-limit failure rolls back that insertion, while an invalid proof outcome commits admission before public refusal. Keep that distinction and the existing conservative ten-minute Retry-After.                                                                 | `shell/tokens/pat-pairing-persistence.ts:13-14,249-278`, `shell/tokens/pat-pairing.ts:305-348`, `shell/db/migrations/0035-pat-pairings.ts:196-220`                                                                                                       |
| PATPairing inspection attempt log                                                                 | D     | Stable User, 5/10min. Reservation commits before canonical review, so rejected review still consumes capacity; later web sessions/public codes do not reset it. The lock is acquired before the count statement's READ COMMITTED snapshot. Stock RateLimiter cannot preserve the rolling policy at this limit.                                                                            | `shell/tokens/pat-pairing-persistence.ts:407-448`, `shell/tokens/pat-pairing.ts:368-400`                                                                                                                                                                 |
| PATPairing wrong proof count / polling slowdown                                                   | T     | Pairing-bound, terminal proof state and increasing poll interval; not replaceable with tokens that refill.                                                                                                                                                                                                                                                                                | `shell/tokens/pat-pairing.ts:230-349`, `core/tokens/pairing.ts`                                                                                                                                                                                          |
| PAT issuance count (manual and paired)                                                            | T     | Both consult the same stable-User issuance history. Revoking a PAT or changing browser session cannot remove issuance evidence or buy more capacity. Issuance shares Consent/Audit commit; there is no expendable counter table to delete.                                                                                                                                                | `shell/tokens/repo.ts:276-303`, `shell/tokens/mutations.ts:105-130`, `shell/tokens/pat-pairing.ts:525-540`                                                                                                                                               |
| SupportRecovery invocation log                                                                    | D     | **Authenticated operator issuer+subject**, not anonymous IP/digest as the #459 baseline said. 5/min and 20/hour per operator; 20/min and 100/hour global. Every authenticated invocation, including a rejected one, commits its count before body decode. Stock fail-mode RateLimiter does not persist over-limit consumption; four sequential buckets also lose atomic joint accounting. | `shell/recovery/repo.ts:52-170`, `shell/recovery/routes.ts`, `shell/db/migrations/0040-support-recovery.ts`                                                                                                                                              |
| SupportRecovery open-case and rejection-event counts                                              | T     | 100 global open cases; User-owned open case, bounded rejected proofs, single-use BackupRecoveryCode and approval all remain security transitions.                                                                                                                                                                                                                                         | `shell/db/migrations/0040-support-recovery.ts:252-291`, `shell/recovery/repo.ts:247-280,408-421`                                                                                                                                                         |
| CardEnrollment preparations / source creations                                                    | T     | Stable User, 12 preparations/hour and 5 accepted create-source attempts/hour, derived from CardEnrollments under enrollment lock. Refusal/ambiguity still counts; new WebSessions and source reuse cannot reset create spend. Domain evidence remains necessary even if Redis were added. Network-spanning execution is separately owned by #468.                                         | `shell/subscription/enrollment-repo.ts:25-26,168-207`, `shell/subscription/card-enrollment.ts`                                                                                                                                                           |
| Statement submissions outstanding / hourly count / Free backfill reservation                      | T     | Stable User: 5 outstanding and 20/hour; idempotent admission and one Free useful backfill share the transaction with submission and SQL queue publication. A bucket cannot release an outstanding slot on finalization or restore entitlement on empty/failed processing.                                                                                                                 | `shell/ingestion/repo.ts:110-157`, `shell/ingestion/mutations.ts:175-261`                                                                                                                                                                                |
| Resend authenticated webhook window + replay/evidence capacity                                    | T     | Global 1,000/calendar minute; delivery-id replay/retry does not consume again, 11,000 retained delivery keys, ten-minute evidence. Replay classification and counter commit atomically.                                                                                                                                                                                                   | `shell/db/migrations/0043-email-ingestion.ts:110-165`                                                                                                                                                                                                    |
| Known forwarded-email global and User windows                                                     | T     | 120/calendar minute global and 100/calendar hour per stable User, charged together with accepted receipt. Address/channel changes do not create another User budget.                                                                                                                                                                                                                      | `shell/db/migrations/0043-email-ingestion.ts:193-266`, `shell/ingestion/mutations.ts:84-128`                                                                                                                                                             |
| Forwarded-email outstanding/deferred/monthly allowance counts                                     | T     | 200 global outstanding, 100/User outstanding, 50/User deferred; Free Colombia-month allowance derives from retained receipt accounting, not a duration bucket. Replay, quota deferral and durable accepted state must remain coherent.                                                                                                                                                    | `shell/db/migrations/0043-email-ingestion.ts:270-310`, `shell/ingestion/email-forwarding-repo.ts`, `core/ingestion/rules.ts`, `shell/ingestion/mutations.ts:84-128`                                                                                      |
| WhatsApp ingress budgets + replay receipts                                                        | T     | Separate global authenticated 600/hour and caller/User 60/hour scopes. Caller is portfolio+BSUID before resolution, stable User afterwards; phone/username/token never owns the counter. Each message charges each applicable scope at most once.                                                                                                                                         | `shell/channels/whatsapp/repo.ts:112-161`, `shell/channels/whatsapp/routes.ts:113-169`, `shell/db/migrations/0012-create-whatsapp-channel.ts:185-244`                                                                                                    |
| WhatsApp outstanding job count                                                                    | T     | Per-User 32 outstanding jobs and 16,000 aggregate content characters (including separators) share message-evidence insertion/enqueue; not a replenishing request quota. Execution/debounce ownership migrates under #467, not this ticket.                                                                                                                                                | `shell/channels/whatsapp/repo.ts:316-380`                                                                                                                                                                                                                |
| Memory aggregate size / keyword-rule count                                                        | T     | 15,000 tokens for the complete User Memory projection; 100 keyword rules/User. Recounted under owning mutation/revision locks, not request-rate windows. Removing or revising content changes capacity; waiting does not.                                                                                                                                                                 | `shell/memory/mutations.ts:41-101`, `shell/memory/memory-policy.ts:26-47`, `core/memory/rules.ts:4-5,21-28`, `core/categories/rules.ts:7-8`, `shell/categories/mutations.ts:43-61`, `shell/categories/repo.ts:105-119`                                   |

Provider-supplied HTTP 429 interpretation, retry schedules, consent delivery windows, session
inactivity, Budget uniqueness/alert latches, configured Sentry account quotas, and payload/page maxima
are not additional custom
shared admission windows. Unimplemented product allowances are not counted as existing controls.

## Verified Effect semantics

Source: `.repos/effect/packages/effect/src/unstable/persistence/RateLimiter.ts`, byte-identical to
the installed RC.112 source during this evaluation.

1. `consume` accepts **one key**, token count, algorithm, window, limit and fail/delay choice
   (`45-60,96-229`). The store API has no joint-consume or rollback operation (`611-674`).
2. Only memory and Redis store layers are supplied (`691-704,909-932,1349-1377`). SQL queue or
   Cluster persistence cannot be substituted for this distinct store interface.
3. Memory maps are owned by each Layer construction (`698-704`). Replicas and restarts receive
   new counters. Sharing a Layer inside one process proves nothing about independent runtimes.
4. Token bucket refills one token per `window / limit`; five starts at t=0 plus one at t=12s are
   legal with limit 5/min (`173-227,739-762`). That weakens a five-in-any-minute rolling policy.
5. The name **fixed-window is not a rolling-log or calendar-window guarantee**. The first token's
   TTL is `window / limit`; each accepted token extends the existing expiry by that amount. One
   start at t=0, expiration at t=12s and five more starts at t=12s are legal for 5/min
   (`721-738`, Redis Lua `1020-1051`). Calendar counters in Ingestion are different too.
6. Fail-mode rejection does not extend fixed-counter TTL or persist a negative bucket balance
   (`732-733,759-761,1039-1042,1084-1098`). This differs from SupportRecovery's intentional
   count-every-authenticated-invocation policy.
7. Redis fixed counters use Redis TTL; token bucket supplies the **application Clock's** time to
   Lua (`955-970,1056-1105`). A new store would need a clock-skew decision as well as durability.
8. Use `onExceeded: "fail"` for public rejection, not queued delay. Map only `RateLimitExceeded`
   to 429 with `max(1, ceil(Duration.toMillis(retryAfter)/1000))`; map store failure to bounded
   unavailable, never success or a memory fallback. Errors contain the key and store causes
   (`377-474`), so they must not escape into bodies, logs or telemetry. This is an adoption
   requirement, **not newly installed behavior**.

The algorithm counterexamples and independent-store reset are executable in
`apps/server/src/shell/tokens/rate-limiter-evaluation.test.ts`. They use memory only to test
algorithm semantics, **not** as distributed evidence. Redis Lua was inspected, not run; no Redis
production readiness or failover claim is made.

## Selected shared-store topology and proof

`apps/server/src/shell/tokens/distributed-admission.test.ts` spawns two independent Bun OS
processes, each with a real loopback socket, declared PATPairing HttpApi, production handlers,
cryptography, its own semaphore/pool and `fidy_runtime` connection to **one PostgreSQL database**.
`apps/server/src/shell/testing/pat-admission-process.ts` asserts restricted runtime authority;
children receive no migration URL or provider credentials, and automatic `.env` loading is disabled. This tests the retained PostgreSQL
control, not two Layers inside one process and not a simulated RateLimiter store.

The test proves:

- four sequential starts split across processes, then forty concurrent starts across both:
  exactly one more succeeds, every other response is 429 or fail-fast 503, within a five-second
  test ceiling;
- both processes return the same generic rejection and positive, bounded Retry-After after the
  fifth success; refused traffic leaves exactly five pairings and five counter rows;
- hard `SIGKILL` of **both** processes, then replacement with new PIDs: both still reject;
- minute refill without losing ten-minute history, then ten-minute refusal on both runtimes
  without extra evidence or pairings, and eventual refill plus production expiry deletion;
- changing the untrusted leftmost X-Forwarded-For prefix cannot reset the rightmost,
  proxy-observed source key; empty/malformed proxy evidence fails closed without a pairing;
  a genuinely different source retains an independent allowance.

Refill is accelerated by aging only the test database's admission timestamps while both children
remain live. No production policy, clock, SQL gateway or counter implementation is replaced. This
proves window selection/expiry behavior, not elapsed wall-time waiting, PostgreSQL crash recovery,
clock-skew tolerance, or the complete production runtime's worker composition. Child resources are
scoped and killed/reaped even on failure. No test control route enters production.

Stable-User keys are **unchanged**, not translated to token/session/provider ids. Existing API
negative tests remain the evidence for User isolation, paired inspection reservations, provider
spend, recipient anti-bypass and rollback: `tokens/pairing-handlers.test.ts`,
`tokens/handlers.test.ts`, `browser-login/approval.test.ts`,
`email-authentication/authentication.test.ts`, `email-authentication/replacement.test.ts`,
`subscription/enrollment-handlers.test.ts`, and the forwarded-email/WhatsApp suites. They are not
claimed as additional two-process proofs.

## Reproduce the representative proof

Use a **disposable, isolated** PostgreSQL database initialized with
`apps/server/tools/local-postgres-init.sql`. Export its restricted `DATABASE_URL` and separate
`MIGRATION_DATABASE_URL`, then run from the repository root:

```sh
bun run --cwd apps/server test --coverage.enabled=false \
  src/shell/tokens/distributed-admission.test.ts \
  src/shell/tokens/rate-limiter-evaluation.test.ts
```

The test runner **drops and recreates `public`** before applying migrations; never point these
commands at a shared development or production database. The proof requires Bun, a loopback listener
and permission to spawn child processes. It makes no provider requests. Coverage is disabled for
this targeted invocation, not for the normal repository gate.

### Verification outcome

The four new tests passed against PostgreSQL 18.6. Related PAT/PATPairing, anonymous-source,
BrowserLogin approval/HTTP, CardEnrollment HTTP, email replacement and forwarded-email suites also
passed. Server typecheck, type-aware lint on the added files, formatting and the server dependency
boundary gate passed.

The broader verification is **not fully green**: the unchanged
`apps/server/src/shell/email-authentication/authentication.test.ts` suite intermittently returned
`Idle` where delivery tests expected `Progressed`, also when run alone without the new tests.
The standalone rerun had two failures (duplicate delivery and completion-capacity scenarios);
earlier grouped runs had additional failures or timed out. This evaluation does not diagnose or
change that workflow. Those failures remain a verification limitation, not evidence of successful
end-to-end email authentication.

## Operational consequence

No new network store, credentials, migrations, production instrumentation or outage mode is added.
Existing closed HTTP status/latency and owning Work observations remain authoritative; no counter
keys, User ids, source digests, mailbox HMACs, proofs or raw store errors are new telemetry fields.
There is no replaced table to delete and no dual-write/fallback path. Before any later Redis
adoption, ADR 0025 requires a separate infrastructure/security/operations decision and a fresh
net-deletion proof.
