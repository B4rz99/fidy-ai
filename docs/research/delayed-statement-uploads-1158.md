# Delayed original statement uploads after cleanup (#1158)

Investigated 2026-10-10 against the installed application, published Effect 4.0.0 source,
and current Cloudflare documentation. This is a bounded local regression and source investigation;
no production experiment, production orphan, or production timing guarantee is established.

## Finding

Statement staging can remove its durable cleanup identity while the original upload is still
unresolved. A later write to that exact object key would then leave private bytes without a staging
row for Maintenance to discover. This is a candidate ordering failure, not stale R2 reads.
The delayed-dispatch fixture deliberately manufactures the uncertain transport timing; it does
not show that Cloudflare's production binding dispatches writes this way.

The relevant owner is [`StatementStaging`](../../apps/server/cloudflare/ingestion/internal/statement-staging.ts),
specifically `stageStatementBytes`, `writeStagingObject`, `discardStagedUpload`,
`prepareStagingRetention`, and `sweepExpiredStatementStaging`.

## Installed ordering and ownership

`stageStatementBytes` bounds and classifies the input, computes its digest, then commits a
`pending` D1 row before calling the private R2 bucket's `put`. The row contains the random object
key and fixed expiry. The write uses a complete `Uint8Array` plus the expected SHA-256 checksum;
there is no stream cancellation handshake with R2. A successful continuation attempts the guarded
`pending → available` D1 transition. If that changes no row, `discardStagedUpload` tries to mark
the row `deleting`, deletes the object, and removes the row. A rejected put is mapped to `false`
and takes that same discard path. These facts follow directly from `writeStagingObject`,
`markStagingAvailable`, and `discardStagedUpload` in the owner file above.

`sweepExpiredStatementStaging` moves expired `pending` and `available` rows, plus previously
`deleting` rows, into one bounded cleanup page. It deletes their R2 keys, then removes rows without
a referencing StatementSubmission. Referenced rows retain lifecycle evidence but receive
`object_deleted_at_ms`, excluding them from later object cleanup. The row is therefore a durable
retry authority for failed deletes, but its removal does not currently establish that an earlier
put cannot still complete. The sweep reads no pending-write receipt or completion fence.

[`statementStagingLifetimeMilliseconds`](../../apps/server/src/core/ingestion/contract.ts) is
24 hours. It prohibits reading and publishing expired material; it is not a bound on how long a
foreign write can remain unresolved. `StatementStaging.make` accepts an owner clock, allowing local
tests to move decision time across expiry without waiting 24 hours.

## External contracts and their limits

Cloudflare documents globally strong read-after-write, delete, and listing consistency, and
completion order determines the winner for concurrent PUT/DELETE operations on one key. Thus a
delete completing before a later put cannot fence the key against that put. Binding access bypasses
the public-domain cache. [R2 consistency model](https://developers.cloudflare.com/r2/reference/consistency/).

The Workers binding promises an object on successful `put` and globally visible absence after
successful `delete`. Conditional put failure returns `null` without storing the object. The published
`R2PutOptions` exposes no AbortSignal; single-object `put` has no counterpart to multipart upload
`abort`. The reference does not state that every rejected put proves no write committed, or that
canceling its caller proves no later commit. Those negative guarantees must not be invented from
the successful-operation contract. [R2 Workers API reference](https://developers.cloudflare.com/r2/api/workers/workers-api-reference/).

Connected HTTP invocations have no fixed wall-time maximum. Runtime updates allow a limited grace
period before terminating in-flight requests; CPU and invocation-specific limits are separate.
The HTTP `waitUntil` extension lasts at most 30 seconds after response/disconnect. Neither duration
establishes the settlement deadline of an already submitted storage write.
[Workers limits](https://developers.cloudflare.com/workers/platform/limits/).

`waitUntil` keeps request-associated promises alive temporarily and cancels unsettled work when
its extension expires. It is not durable background execution or a documented remote-write rollback.
[Workers context](https://developers.cloudflare.com/workers/runtime-apis/context/).

The installed **Effect 4.0.0** source inspected at
`node_modules/effect/src/internal/effect.ts`, symbols `tryPromise`,
`callbackOptions`, and `asyncFinalizer` (starting at lines 1114, 1152, and 1209), matches the selected
release described by [the repository source map](../../.patterns/effect-4-stable.md).
`tryPromise` requests a cancellation signal only when the supplied function declares a parameter
(`f.length !== 0`). Its async boundary suppresses a later promise resume once interrupted. A signal,
when requested, only aborts its controller; the foreign API must honor it. Staging's
`platformUnavailable` passes a zero-parameter callback, so it neither creates nor passes an abort
controller to `bucket.put`. Interrupting that Effect stops the staging continuation without canceling
the underlying promise. The corresponding published source is
[Effect 4.0.0 internal effect.ts](https://unpkg.com/effect@4.0.0/src/internal/effect.ts);
the installed release, rather than refreshed upstream main, was the source actually inspected.

## Production entrypoints and deadlines

The internet-facing [`Public Worker`](../../apps/server/cloudflare/public-worker.ts) rebuilds the
Core request, runs the public Effect with `request.signal`, and supplies the Effect signal to
`CORE.fetch` in `routeOwnedRequest`. However,
[`makeCoreHttp`](../../apps/server/cloudflare/core-http/runtime.ts) calls `Effect.runPromise`
without a request signal. Public forwarding cancellation therefore does not by itself demonstrate
interruption of Core's staging fiber. Core's bounded body collector observes request abort while
collecting; after it has returned complete bytes, staging has no independent request-abort race.
See [`collectBoundedRequestBody`](../../apps/server/cloudflare/http/operations.ts).

The retained `uploadStagedStatement` composition calls the same owner adapter after resource
admission and releases its outstanding lease in a finalizer. This helper's existence must not be
mistaken for a currently authorized public submission route: application architecture specifies
the installed statement journey through verified WhatsApp attachments and held publication.
See [`statement-ingestion.ts`](../../apps/server/cloudflare/ingestion/internal/statement-ingestion.ts)
and [server architecture, statement upload conversation](../../apps/server/ARCHITECTURE.md).

The installed attachment path is
[`prepareStatementDocumentReply` / `documentReference`](../../apps/server/cloudflare/agent/internal/statement-document.ts)
→ bounded Kapso retrieval →
[`withHeldStatementDocumentUpload` / `stageHeldStatementDocument`](../../apps/server/cloudflare/ingestion/internal/statement-document.ts)
→ `StatementStaging.make(...).stageStatementBytes`. It uses a synthetic internal Request containing
the already verified bytes. Its upload grant is checked before staging and before retention of the
returned reference; grant expiry does not cancel R2. The original staging decision time is retained.

[`hostedDeadline`](../../apps/server/cloudflare/agent/internal/service.ts) has a 25-second soft
response timer. Before admission it aborts preflight; after admission it returns processing while
owner execution continues. `boundedHostedOwner` later recovers abandoned work. The document
branches in [`hosted-turn.ts`](../../apps/server/cloudflare/agent/internal/hosted-turn.ts) call
`prepareStatementDocumentReply` directly; the model-round `exitOnAbort` and `Effect.timeout`
wrappers elsewhere in that file do not wrap those statement branches. Consequently neither the
25-second response nor a model-round timeout is evidence that production statement writes are
interrupted at that instant. Runtime termination remains possible, but its storage-side result is
not established by the local injected schedule.

## Candidate orderings

| Case                            | Original write / owner sequence                                                                                                                                      | What can be concluded                                                                                                                                                                                        |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Live delayed success            | Insert pending row; expiry sweep deletes the absent key and row; original put completes; available transition changes zero rows; live discard deletes the new object | Continuing staging execution can compensate after success. Earlier cleanup alone is insufficient.                                                                                                            |
| Interrupted upload              | Insert pending row; put remains unresolved; interrupt staging Effect; expiry sweep deletes key and row; injected original put dispatch completes later               | No continuation remains to compensate; a durable local orphan demonstrates the application's missing fence under this injected schedule. It does not prove production abort semantics.                       |
| Ambiguous rejection             | Insert pending row; injected put wrapper rejects while retaining scheduled dispatch; discard deletes key and row; retained dispatch writes later                     | Application equates rejection with settled absence. The fixture demonstrates the consequence if that equivalence is false; Cloudflare documentation does not establish this exact rejection schedule occurs. |
| Definitively unsuccessful write | Put cannot commit; discard deletes key then removes row                                                                                                              | Safe only with actual evidence that no later write remains possible. A missing HEAD at one instant is insufficient evidence while a write is unresolved.                                                     |

All cases retain expiry/publication guards. Private orphan bytes do not automatically become
readable or publishable: the owner requires a same-User staging row, and canonical publication
requires retained live premises. The local regression must assert both physical residual storage
and refusal by the owner for the original User and a different User. Lack of readability does not
remove the retained-material cleanup obligation.

## Bounded local regression and verification

The regression enters at `StatementStaging.make` using local persistent D1/R2 bindings and an
explicit transport substitution below owner policy. It schedules a gate-delayed original put,
advances the owner clock through expiry, executes the real sweep, and finally lets the original
dispatch reach R2. Persistent storage and workerd restart distinguish retained bytes from a
JavaScript-only mock result. Synthetic bytes and bounded gates replace real financial material and
unbounded delays. The rejected wrapper and explicit fiber interruption are injection choices.

Verified locally with the pinned Bun `1.4.3-canary.1+13a98b0db`, Effect `4.0.0`, Vitest `5.0.3`,
and Miniflare `5.20260911.1-alpha` on macOS. The retained fixtures are
[`statement-upload-race.test-fixture.ts`](../../apps/server/cloudflare/ingestion/statement-upload-race.test-fixture.ts)
and [`statement-staging.test.ts`](../../apps/server/cloudflare/ingestion/statement-staging.test.ts).

| Injected schedule                         | Before releasing original work    | After release and workerd restart                                  | Next sweep                                  |
| ----------------------------------------- | --------------------------------- | ------------------------------------------------------------------ | ------------------------------------------- |
| Interrupted waiter, then expiry cleanup   | R2 key absent; staging row absent | R2 key present; staging row absent                                 | Zero objects/rows reclaimed; object remains |
| Rejected acknowledgement, then discard    | R2 key absent; staging row absent | R2 key present; staging row absent                                 | Zero objects/rows reclaimed; object remains |
| Live delayed success after expiry cleanup | R2 key absent; staging row absent | Continuing caller refuses availability and deletes the late object | No residual object                          |

The first two rows falsify the cleanup invariant under the injected timing: every retained original
object should have durable cleanup ownership. The tests deliberately assert this observed failing
state so the reproducer stays executable in CI; they do not label it an acceptable protocol outcome.
A corrective follow-up must invert the residual-storage assertions to protect recoverable ownership
or enforce absence after later writes are fenced. The live-continuation case does not need restart
because it settles the original upload and verifies actual object absence.

Commands and results:

- `bun run --cwd apps/server test:cloudflare cloudflare/ingestion/statement-staging.test.ts`:
  **21 passed**, including both restart reproductions, live compensation, expiry publication refusal,
  and published-source ownership past the unchanged 24-hour staging deadline.
- `bun run --cwd apps/server test:cloudflare cloudflare/ingestion/statement-staging.test.ts cloudflare/ingestion/statement-ingestion.test.ts`:
  **73 passed** before the final additional published-owner case; the unchanged ingestion file
  contributes 53 tests covering existing canonical publication and retention behavior.

Both Users receive the same safe unavailable-material publication refusal after restart, neither
can read the stale reference, and no StatementSubmission or submission Audit is created. Synthetic
expiry never extends the original deadline. Published material is excluded from the unpublished
sweep and remains readable only to its submission's User. No new production workflow is added,
so this evidence-only change requires no telemetry sink.

## Smallest owner-correct follow-up

Keep cleanup authority in the Ingestion staging owner until original-write ambiguity is resolved.
Represent unresolved upload settlement separately from availability and cleanup eligibility, so
expiry refuses reads/publication immediately without authorizing permanent removal of the locator
while a write could still land. Rejected or interrupted writes must retain that identity and join
durable reconciliation rather than disappear as successful deletion evidence. Successful settlement
after expiry should trigger cleanup under the retained identity; cleanup may retire authority only
once there is an established no-later-write fence or independently adequate bucket-side lifecycle
guarantee. Persist only bounded identity/lifecycle metadata, never statement bytes in D1.

The exact finite retirement mechanism remains a separate design decision requiring a documented
storage/lifetime contract or another enforceable protocol. An in-memory pending registry cannot
survive lost Workers, an immediate compensating delete cannot prevent a later put, and an arbitrary
grace period cannot prove settlement. `Effect.uninterruptible` may preserve a live waiter but does
not prevent expiry cleanup racing it and cannot survive runtime termination. Do not claim any of
those alone closes the durable race. This investigation deliberately proposes the owner's required
invariant rather than shipping an unproven production retention policy.

Reusable parsed statement material currently has D1-owned publication and erasure in
[`statement-materialization.ts`](../../apps/server/cloudflare/ingestion/internal/statement-materialization.ts).
Generation validation there does not fence an original R2 write. If derived bytes acquire an R2
lifecycle, they must retain their own cleanup authority across unresolved writes as well; original
and derived locators must not be retired merely because another owner's D1 generation was deleted.
