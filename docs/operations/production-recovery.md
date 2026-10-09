# Production recovery

1. **Identify the boundary.** Check the Production GitHub Actions run and [release receipt](production-releases.md), public and Core version identities, Cloudflare Worker metrics/logs, the private [operational health view](cloudflare-background-work.md), and relevant D1 owner state. A green `/health` is reachability, not proof of background delivery or provider settlement. Keep User identifiers, payloads, and credentials out of issue comments and logs.
2. **If candidate smoke failed before promotion**, leave stable traffic at 100%; let the controller remove only its own 0% candidates. Inspect failed bindings and Alchemy state; fix forward through reviewed `trunk`. Do not deploy from a dashboard or workstation.
3. **If normal traffic failed after promotion**, inspect the captured immutable public/Core pair and its seven-day receipt. Use the guarded [code-only rollback](production-releases.md#immediate-post-promotion-code-failure-720) only when unchanged bindings, migration history and lifecycle permit it. A refusal or uncertain traffic state calls for operator inspection and a reviewed fix-forward release, never a forced deployment.
4. **If state or async work failed**, rollback cannot undo D1 migrations, Durable Object storage/lifecycle, R2 bytes, Queue messages, Workflow instances, secrets, routes or provider effects. Keep additive schema compatibility; inspect D1 outbox and owner lifecycle, then follow [background-work recovery](cloudflare-background-work.md#safe-recovery) and retention signals. Reoffer only eligible durable identities; dead letters are not authority.
5. **If a provider result is ambiguous**, never repeat a charge, proof email or WhatsApp send solely because a response was lost. Follow the owning reconciliation policy, especially [Wompi collection ambiguity](../runbooks/billing-ambiguity.md). Verify a terminal domain outcome before marking recovery complete.
6. **Confirm restoration.** Verify normal-traffic release identities, synthetic smoke, the affected User-owned operation or owner lifecycle through an authorized seam, alert delivery, and retention cleanup. If D1 or Cloudflare itself is unavailable, operator console inspection and the independent GitHub release-failure email are the fallback; no second database or cross-provider restore is promised.

Before first real-User ingress, complete the empty-stack synthetic proof and rollback/refusal exercise in the [Production release runbook](production-releases.md). These steps are not a substitute for that remote evidence.

## Inspected deleted Queue incident — 2026-10-08

[Production evidence](https://github.com/B4rz99/fidy-ai/actions/runs/37854432026) identifies a Queue
refusal. Stable Core `fa578c5f-2e94-4507-ba70-1fe4fe4dd150` retains a deleted onboarding Queue
binding. Recreating its name does not restore the immutable binding. D1 contains User records;
preserve all state and do not use an empty-stack reset.

The reviewed incident dispatch uses the protected Production workflow:

```sh
gh workflow run production.yml --ref trunk -f recover_deleted_queue=true
```

It accepts only the inspected stable public/Core IDs. Alchemy uploads candidates first. The
controller confirms Core has no public domain, zone route or workers.dev/preview URL, installs
only the isolated Ingress version, and proves ordinary admission returns 503 before replacing
private Core. Both candidates must declare isolation; Core also denies admission during public
routing propagation. Metadata health and authenticated synthetic smoke remain available. No old public
version remains selectable by an override. Failure leaves admission closed and alerts the operator.

After normal-routing synthetic proof, the workflow captures that isolated baseline and returns to
the ordinary zero-traffic, exact/intermediate smoke, promotion and post-promotion gates. Core's
version message distinguishes the recovery and ordinary uploads. No force flag, resource recreation,
state reset, workstation deployment or automatic restoration of the deleted binding is allowed.
