# Production launch proof — issue 725

**Status: BLOCKED. This record does not authorize onboarding, provider effects, deployment,
or destruction.** Closed prerequisite issues and passing local tests are not live launch evidence.
Production is the only remote proving ground; do not create staging or preview infrastructure.

Use the existing [release controller](production-releases.md),
[background-work checks](cloudflare-background-work.md), and
[recovery guide](production-recovery.md). Add a focused check only where they cannot prove a required
behavior. The deployment-recovery agent owns current controller repairs; coordinate before touching
release code or performing any remote write.

## Evidence rules

For each completed check, record UTC time, exact Git revision, contract digest, immutable public/Core
version IDs where applicable, tool versions, compatibility date/flags, procedure, expected outcome,
observed outcome, and a restricted evidence reference. Cloudflare's managed runtime is not a pinned
binary: record the deployed compatibility configuration and observed platform behavior instead.
Evidence applies only to the tested configuration; rerun affected checks after changes.

Keep credentials, User identifiers, private agreements, provider payloads, model content, and raw
platform errors out of Git, issue comments, and routine logs. Store only bounded outcomes and
references here. `PENDING` means unproved, not healthy. Provider acceptance is not delivery receipt;
Queue acknowledgment is not Workflow completion; instance creation is not execution.

## Initial read-only observations

Observed **2026-09-29 19:10 UTC**, from checkout
`d2504728c6c2a8cd64ee96b48798bb052a60c998`:

| Observation               | Evidence and limits                                                                                                                                                                                                                                                                                                                                  |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Prerequisite issues       | 713, 714, 715, 717, 720, 721, and 724 are closed. Their account-specific conditions still require verification.                                                                                                                                                                                                                                      |
| Latest Production release | [Run 36616992687](https://github.com/B4rz99/fidy-ai/actions/runs/36616992687), revision `d83db2acc949d39b055d50aff62e34999182547f`, failed at **Reject drift from the deployed Cloudflare topology**. Candidate upload, promotion, smoke, edge probes, and post-deployment drift were skipped.                                                       |
| Live AI conformance       | That run passed **Gate the approved Workers AI model against live conformance**. This proves that run's selected model, not every hosted product journey.                                                                                                                                                                                            |
| Applied D1 history        | That run passed **Reject drift in applied D1 migration history**. It does not prove all D1 transaction semantics or an empty database.                                                                                                                                                                                                               |
| Failure email             | That run passed **Email operator if deployment failed**. Operator inbox receipt remains unverified.                                                                                                                                                                                                                                                  |
| Public bound health       | `/health` reported `available`, revision `2d65bde42f81b5c4af377e433100a7500bec0a5b`. Health does not expose both immutable Worker IDs or prove async execution.                                                                                                                                                                                      |
| Static artifact           | `/deployment-metadata.json` reported revision `bb266058b40663208c2478ae48af4fe8bb5fa79d`. It differs from health: do not claim an exact coherent launch release. Both reported contract digest `f33c9633df9fdfe0dbb730156fe9083dc4d0f676648a27d102f73bc98262fd4f`.                                                                                   |
| GitHub environment        | Production API reports a custom deployment-branch policy. Its exact allowed branches still need verification. Environment secret-name inventory includes current provider credentials and obsolete Railway/Resend-inbound/Sentry-related configuration; presence does not establish active use or secret correctness.                                |
| Email Routing             | `infra/cloudflare/alchemy.run.ts` intentionally provisions no inbound rule. Server architecture says institution Connection-state admission and authenticated sender provenance are missing. Do not enable real forwarded-mail delivery.                                                                                                             |
| Operational gaps          | Background-work runbook says account budget/usage notifications are unverified; Worker exception, CPU/memory-limit, and callback-rejection counters have no automatic email alert after Tail removal. Native metrics require manual inspection. These gaps need an explicit launch decision or implementation, not a claim that alerts are complete. |
| Onboarding boundary       | The topology has no explicit launch-enable binding. This audit has not established whether real onboarding is currently reachable or whether any real User exists. **Do not assume the stack is empty or that ingress is closed.** Establish both before synthetic writes or reset planning.                                                         |

Commands used: `gh issue view`, `gh run list`, `gh run view --json jobs`, GitHub environment metadata
and configuration-name inventory, and bounded GETs to the two public metadata endpoints. No
production state, provider settings, deployment traffic, or onboarding settings were changed.

## 1. Establish a safe proving window

- [ ] Deployment agent finishes recovery; record the successful release and exact public/Core pair.
- [ ] Operator confirms whether any real User or retained personal data exists. Use restricted,
      metadata-only evidence; do not export product tables to prove emptiness.
- [ ] Identify and verify how new onboarding and real provider ingress are held closed. If no
      enforceable boundary exists, implement and negatively test it before remote fault injection.
      Preserve access required for existing Users and data rights if the stack is not empty.
- [ ] Operator approves the synthetic namespace, bounded spend, test mailbox/contact, procedures,
      cleanup, and any temporary fault injection. No real charge, customer message, or financial data.
- [ ] Serialize remote writes with the GitHub Production coordinator. Do not deploy from a workstation
      or dashboard, race the deployment agent, bypass drift checks, or reuse one-time recovery modes.

If real data exists, stop the empty-stack/destruction plan. Obtain an explicit revised procedure;
ordinary User deletion or code rollback is not permission to replace the authoritative baseline.

## 2. Platform proof matrix

All rows are **PENDING** except the limited AI evidence above. Local test files are prior art for the
claims, not substitutes for remote proof. Use reserved synthetic resources/state; do not add a
public generic SQL, storage, or fault-injection endpoint.

| Boundary          | Required live outcome                                                                                                                                                                                                                                                                                                        | Existing seam / remaining work                                                                                                                                                                                            |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1                | Failed multi-statement batch rolls back domain, audit, and outbox together; constraints, foreign keys, adopted triggers, `RETURNING`, exact Money round trips, error classification, migration markers, and actual statement/parameter limits behave as required. Immediate reads observe commits with replication disabled. | `infra/cloudflare/d1-migrations.test.ts`, `apps/server/cloudflare/resource-admission/resource-admission.test.ts`, mutation adapters. Design a bounded private prelaunch probe for semantics not covered by release smoke. |
| Durable Objects   | Same-subject requests serialize, different synthetic subjects remain independent, retries/restart retain coordination compatibility without creating a second financial authority.                                                                                                                                           | `UserTransactionCoordinator`, Cloudflare adapter tests; ordinary reserved smoke proves compatibility only. Controlled concurrent/restart proof still required.                                                            |
| Queues / outboxes | Duplicate delivery, reordering, partial failure, lost publication settlement, decode rejection, and exhaustion leave one truthful durable outcome; dead letters and recovery remain visible.                                                                                                                                 | Installed owner consumers and outboxes; `infra/cloudflare/smoke-work.test.ts` and background-work runbook. A successful no-op is not forced platform redelivery evidence.                                                 |
| Workflows         | Retry, durable wait/resume, ambiguous external completion, replay, version-compatible stored envelopes, and cleanup preserve owner outcomes. Incompatible definitions require a new name or reviewed drain plan.                                                                                                             | Existing versioned Workflows and owner tests. Record actual deployed execution/version behavior, not only instance creation.                                                                                              |
| R2                | Reserved marker read/write and cleanup work; private bytes cannot be retrieved without subject authority; expiry removes test bytes and associated publication state.                                                                                                                                                        | Exact-version smoke plus statement staging/retention adapters. Record private bucket policy and authorized test outcomes.                                                                                                 |
| Service bindings  | Exact candidate pair and stable-public/candidate-Core pairing both pass; Core has no public route or workers.dev exposure; ingress has no D1 binding.                                                                                                                                                                        | Existing release smoke and topology authority. Async smoke does not prove candidate async code ran.                                                                                                                       |
| Email             | Synthetic routing/admission, bounded hostile content, replay, retention, and terminal outcome are proved without enabling real inbound mail prematurely.                                                                                                                                                                     | Forwarded-email local adapters exist; routing and production admission remain blocked. Resolve scope explicitly rather than quietly adding institution Connections.                                                       |
| Workers AI        | Approved model passes live tool/structured-output/continuation and es-CO conformance; bounded hosted journey rejects invalid output and cross-subject authority.                                                                                                                                                             | Existing live conformance release gate; preserve its run/model identity and separately prove the relevant hosted journey. No external-model fallback.                                                                     |
| Releases          | Broken candidate stays at zero normal traffic; next release is not poisoned; exact pair promotes; failed normal-traffic smoke restores eligible code; changed deployment/binding/lifecycle refuses rollback; manual fallback works.                                                                                          | Existing controller and prelaunch exercises in production-releases.md. Deployment agent owns current repairs. State is never rolled back by restoring Worker traffic.                                                     |

## 3. Provider and operator gates

- [ ] **Kapso MVP:** preserve the operator's accepted, disclosed indefinite Free-plan retention.
      Do not change it to finite retention or require an upgrade solely to undo that decision. Record
      production-number readiness, webhook proof/replay evidence, Terms/DPA/subprocessors and actual
      transcript configuration, unused-feature review, and a tested deletion/support process.
      [Kapso readiness](kapso-launch-readiness.md) and its JSON check still encode a separate finite-
      retention launch gate; reconcile that gate's applicability with the operator before using it as
      the issue-725 sign-off. Do not fabricate a passing finite-retention record.
- [ ] **Wompi:** verify environment, production eligibility and accepted Price terms, callback
      authenticity, monotonic settlement, replay, and timeout reconciliation using approved provider
      tests. No live charge without separate approval.
- [ ] **Resend:** verify sending-domain readiness and actual receipt at the approved test mailbox;
      prove bounded authentication delivery/replay without creating a real User.
- [ ] **Privacy:** restricted review records foreign processing, provider agreements/disclosures,
      retention/deletion limits, and executable Titular-rights handling. Operator/legal approval is
      required; code cannot establish legal approval.
- [ ] **Edge and secrets:** verify effective WAF/DDoS/rate limits, browser-origin policy, PAT flows
      without CAPTCHA, invalid callback rejection with no effects, Core privacy, least-privilege tokens,
      secret bindings, protected-trunk-only deployment, and disabled provider source deployments.
      Inventory obsolete account integrations/configuration for approved retirement; names alone do
      not justify deletion or prove an integration is running.
- [ ] **Observability:** prove safe telemetry, async canary completion, dead-letter/Workflow alerts,
      real operator inbox receipt, resolution, and deployment-failure email. Resolve the missing Worker
      exception/limit/callback-spike alert coverage. Verify account budget and usage notifications and
      required paid capabilities against the live account; manual dashboards are not automated alerts.

## 4. Clean authoritative baseline

Only after the proving window and any destructive action have separate operator approval:

1. Close synthetic admission and pause/drain the approved test publishers before cleanup. Account for
   cron, DO alarms, pending outboxes, Queue retries/dead letters, and Workflow instances. Deleting D1
   rows first can leave work capable of recreating state or causing delayed provider effects.
2. Reconcile every synthetic provider effect and terminate or drain test work through the owning
   lifecycle. Record terminal states, not just Queue emptiness or Workflow creation.
3. Remove approved synthetic product/evidence rows, staged/retained R2 bytes and markers, and reserved
   coordination state where removal is safe. Retain only explicitly documented bounded operational
   smoke/canary state; natural expiry counts only after removal is observed.
4. Verify the authoritative baseline: applied D1 names/hashes unchanged, stable Category seeds intact,
   no test User/financial/identity/outbox records, no outstanding test Queue/Workflow work, no test R2
   material, and no alarm/retry capable of repopulating it. Record restricted count/status evidence
   twice across the relevant cron/retry window.
5. Verify the normal release path and exact compatible pair again. Re-enable only the reviewed
   routine operational smoke/canary publishers, not real onboarding or Email Routing.

Applied D1 migrations are already immutable and forward-only; **keep those guards active throughout**.
This checklist grants no exception to edit applied SQL, replace the migration ledger, or recreate
D1. If reconciliation is insufficient, stop for a separately reviewed reset procedure and approval.
No full-stack destroy command belongs in ordinary release or rollback tooling.

## 5. Explicit launch decision

- [ ] All applicable rows have dated evidence; unresolved scope and provider decisions are explicit.
- [ ] Clean baseline verified and forward-only migration guards confirmed active.
- [ ] Exact release, provider configuration, disclosure revisions, and operator approval recorded.
- [ ] Record the concrete reviewed change that enables onboarding/real ingress and its rollback or
      disable procedure. Apply only through protected GitHub Production authority after approval.
      Leave unsupported Email Routing disabled; do not label the full email requirement complete.
- [ ] After enablement, verify the first approved onboarding completes with its mandatory verified
      email, Consent, and one stable User; use the approved product journey, never a fabricated proof.

**After approval to admit real Users, destructive baseline replacement is prohibited**, even if no
User has arrived yet. Future changes are additive and forward-only; Worker rollback is code traffic
only. Retention and Titular-rights deletion remain purpose-bound operations, not baseline reset.
Do not close issue 725 while required live proofs or enablement remain pending.
