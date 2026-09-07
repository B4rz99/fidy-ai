# Consent disclosure reconciliation is owned by one deep WhatsApp module

- **Status:** Accepted
- **Date:** 2026-08-09

## Context

A WhatsApp disclosure attempt is WhatsApp-owned operational state, while the pending exchange and its disclosure evidence are Consent-owned. Accepted provider evidence must advance both records atomically. Definitive rejection may schedule bounded retry, but an ambiguous outcome must never cause another send.

Kapso's authenticated lifecycle webhook is the reconciliation evidence seam. If a webhook is permanently missed, the attempt remains ambiguous until the pending exchange expires; expiry ends execution as `not-current`, not as proof of delivery or rejection. Recipient identity, content, approximate time, and generic logs are not correctness evidence.

The earlier operator gateway spread claims, transitions, privileged state, and audit mechanics across a CLI, a role, SQL functions, repositories, and acceptance tests. It also offered no trustworthy human-only evidence source beyond what automatic reconciliation can consume.

## Decision

One deep WhatsApp disclosure-delivery module exposes request delivery, apply authenticated lifecycle evidence, and a finite provider-attempt worker seam. A slice-owned Effect Workflow owns continuation and durable retry clocks (ADR 0024, #466); routes and onboarding do not coordinate that machinery.

The request binds the authenticated caller to the pending exchange and atomically commits receipt handoff, immutable routing, and identifier-only native queue publication. HTTP success acknowledges accepted work, not Kapso delivery. One Workflow is identified by `PendingConsentExchangeId`: this is pre-User work, so no artificial `UserId` is introduced. Activities arm a fresh provider attempt before sending; replay of an armed attempt never repeats the provider call. Retry Activity identities include the preceding evidence revision, so a skipped arm cannot cache away a later valid evaluation of the same ordinal. Retry waits persist even for sub-minute delays, with at most four sends and jittered 1–2s, 2–4s, and 4–8s intervals.

Under the exchange lock, authenticated callbacks recheck currentness using current time, apply event-time evidence and the Consent transition, and publish an identifier-only evidence notification in the same SQL transaction. A native queue consumer completes the revision-specific DurableDeferred outside that transaction. The resumed Workflow reloads owner evidence rather than trusting notification contents or caching mutable facts in an Activity. Its evidence/currentness snapshot uses the same exchange lock, preventing a concurrent Consent transition from being misclassified as expiry. Direct deferred completion under the transaction was rejected: the two-runner SQL test exposed notification timeout before commit. The queue bridge preserves atomicity without network-dependent commits.

Kapso remains a true external seam with production and deterministic fake adapters. PostgreSQL remains concrete behind the module; no repository port is introduced. Delivery tables are private: `fidy_runtime` has no table DML or read authority and can execute only state-checked gateways. The module generates one random attempt UUID, sends that value as the opaque callback token, and stores only its SHA-256 hash. Authenticated callback evidence is hashed before lookup.

Provider rejection or exhausted retry stops sending but does not complete the Workflow while newer authenticated evidence remains admissible. The Workflow continues waiting until verified delivery or exchange expiry; definitive failure and its safe reason remain in the owner evidence. This avoids a permanently rejected execution contradicting later Consent advancement or stranding reopened retry eligibility.

Authenticated lifecycle bodies are authoritative. The unsigned event header must agree with the latest chronological status in the authenticated status history. `sent` is nonterminal; verified `delivered` or `read` evidence advances Consent, and only allowlisted transient failures can schedule another of at most four sends.

Manual reconciliation, `fidy_operator`, `OPERATOR_DATABASE_URL`, and the operator CLI are removed. A future human recovery path requires a separate decision naming trustworthy evidence unavailable to automation and a narrowly scoped authority.

## Cutover and retention (#466)

Stop and drain the old disclosure workers before applying migration 0048; do not overlap old and new executors. The migration translates retained requests and provider evidence, removes unarmed claim-only rows, and drops claim/retry scheduling gateways and fields. Start the new workers only after migration. Startup publishes a bounded page of eligible translated requests and paces remaining pages. No backward-compatible claim executor remains.

Routing snapshots survive pending-exchange deletion solely for bounded terminal cleanup. Retention requires completed publication and evidence notifications, a completed Workflow, and quiescent workflow/clock mailboxes before erasing execution history and private request data. It does not delete active timers or interrupt execution to manufacture terminality.

Finite provider attempts, owner-state evaluations, and native queue handlers use the application Telemetry seam with closed disclosure operation and outcome labels. Durable waits stay outside these spans. Expected rejection, ambiguity, and retry exhaustion declare outcomes without duplicate failure captures; escaped failures are reported once at their disjoint Work boundary, and pure interruption is not reported as failure. No routing, correlation, provider body, or exchange identity enters telemetry payloads.

## Consequences

The module interface is small while its implementation is deep. Callers and public-channel acceptance tests do not coordinate claims, leases, attempts, retry timestamps, or SQL transitions. The executable channel contract includes authenticated webhook reconciliation and no automatic replay after ambiguity.
