# Production recovery

1. **Identify the boundary.** Check the Production GitHub Actions run and [release receipt](production-releases.md), public and Core version identities, Cloudflare Worker metrics/logs, the private [operational health view](cloudflare-background-work.md), and relevant D1 owner state. A green `/health` is reachability, not proof of background delivery or provider settlement. Keep User identifiers, payloads, and credentials out of issue comments and logs.
2. **If candidate smoke failed before promotion**, leave stable traffic at 100%; let the controller remove only its own 0% candidates. Inspect failed bindings and Alchemy state; fix forward through reviewed `trunk`. Do not deploy from a dashboard or workstation.
3. **If normal traffic failed after promotion**, inspect the captured immutable public/Core pair and its seven-day receipt. Use the guarded [code-only rollback](production-releases.md#immediate-post-promotion-code-failure-720) only when unchanged bindings, migration history and lifecycle permit it. A refusal or uncertain traffic state calls for operator inspection and a reviewed fix-forward release, never a forced deployment.
4. **If state or async work failed**, rollback cannot undo D1 migrations, Durable Object storage/lifecycle, R2 bytes, Queue messages, Workflow instances, secrets, routes or provider effects. Keep additive schema compatibility; inspect D1 outbox and owner lifecycle, then follow [background-work recovery](cloudflare-background-work.md#safe-recovery) and retention signals. Reoffer only eligible durable identities; dead letters are not authority.
5. **If a provider result is ambiguous**, never repeat a charge, proof email or WhatsApp send solely because a response was lost. Follow the owning reconciliation policy, especially [Wompi collection ambiguity](../runbooks/billing-ambiguity.md). Verify a terminal domain outcome before marking recovery complete.
6. **Confirm restoration.** Verify normal-traffic release identities, synthetic smoke, the affected User-owned operation or owner lifecycle through an authorized seam, alert delivery, and retention cleanup. If D1 or Cloudflare itself is unavailable, operator console inspection and the independent GitHub release-failure email are the fallback; no second database or cross-provider restore is promised.

Before first real-User ingress, complete the empty-stack synthetic proof and rollback/refusal exercise in the [Production release runbook](production-releases.md). These steps are not a substitute for that remote evidence.

## Isolated erasure replay candidate

A database recovery candidate uses a separate database, Worker, and User coordinator namespace.
The operator-only entrypoint is
`apps/server/cloudflare/erasure/candidate-worker.ts`. It exposes the existing short-lived Access
operator proof boundary, not canonical operations. Keep `workers_dev` and `preview_urls` disabled,
configure no public routes, cron, queue consumers, production service bindings or workflow triggers,
and invoke it through an independently authorized private operator path. Production ingress,
Workers, coordinators and background jobs must retain only the serving database binding. Do not
restore the serving database in place.

Provision the candidate separately and import a consistent supported snapshot into it. D1 Time
Travel restores its selected database; it does not provide the isolated fork required here. An
export/import is a distinct recovery procedure and does not establish that an arbitrary historical
Time Travel point can be exported without first restoring a separate staging source. See
[Cloudflare's Time Travel documentation](https://developers.cloudflare.com/d1/reference/time-travel/).

Set `DB` to the candidate database and `USER_TRANSACTION_COORDINATOR` to its fresh private
namespace. Give that coordinator the candidate's original-byte buckets and the independently
retained `ERASURE_BUCKET`. Do not reuse serving coordinators or provider credentials. Configure
`ERASURE_CANDIDATE_DATABASE_ID` and `ERASURE_SERVING_DATABASE_ID` from the control-plane inventory;
matching or missing IDs refuse all candidate work. These strings are configuration checks, not
proof of the actual binding: compare the uploaded version's database UUID, coordinator namespace,
service bindings and routing with the provider inventory before invoking it. A mislabelled binding
cannot be qualified by this application check.

Using the erasure operator Access audience, repeat `Restore` until `AwaitingDisposition`, then
`Continue` the replayed cases using their ordinary references. Unsealed pending cases remain blocked
until independent sealing evidence exists; never manufacture that evidence from a restored writer
ledger. Replay preserves the erasure state machine and custody disposition, and does not issue
provider cancellation or deletion requests. `Receipt` remains available. Candidate mode refuses
`Initialize`, `CustodyEvidence` and `ReleaseRestore`; it cannot publish a serving generation.

Repeat `VerifyCandidate` until it reports `Verified`. Each invocation verifies at most four ledger
cases, including their same-User replay membership, deletion steps, native User absence and settled
writers. Missing or malformed independent evidence refuses verification. A changed generation
restarts verification; interruption does not advance the checkpoint. Compare-and-swap writes retain
progress at `recovery/candidates/<database-id>` in the independent R2 registry, outside the restored
snapshot. Repeating verification of a completed checkpoint performs a fresh pass.

The checkpoint always reports `providerIsolation: Unqualified`. It records an observation of replay,
not serving authorization or a final cutover checkpoint. It must never bypass the live R2 recovery
guard. Admission/drain, late-case reconciliation, stale-Worker enforcement, a provider-verified
binding inventory and resumable fail-closed activation remain separate release requirements.
The existing guard stays enabled until those requirements are proven. The candidate has no automatic
retry or background dispatch; the bounded operator response and durable checkpoint own continuation.
Provider Access-key I/O uses the existing bounded outbound policy; no User content enters telemetry.
