# Operational follow-up — #1262

Assessment: 2026-10-13. Repository base:
`bb65cd1c53e700271b11fa19994655728afa849e`. This record separates observed release
checks from the incident and delivery evidence that is still missing.

## Observed evidence

The protected [Production run 38444348912](https://github.com/B4rz99/fidy-ai/actions/runs/38444348912)
started at `2026-10-13T18:08:37Z` for that exact revision and completed successfully.
GitHub's job/step results record successful reviewed edge-policy verification, exact-pair
routing checks, candidate and intermediate pairing smoke tests, post-promotion normal
traffic probes, public topology verification, credential-free edge probes and drift rejection.
These are deployment checks, not an incident exercise or proof of every account setting.
The checked-in `.github/workflows/production.yml` and
`infra/cloudflare/verify-edge-smoke.ts` define their scope. The edge probe checks refusal
status and no-store, CORS, framing, content-type, referrer and HSTS policy; the MCP probe
also checks its exact authentication challenge. No new production exercise was run for
this follow-up.

Read-only GitHub environment inventory confirmed that the Production environment defines
`OPERATOR_ALERT_EMAIL` and `RESEND_API_KEY`. Values were not retained in this record.
The **Test operator alert email** workflow has no recorded runs as of this assessment.
Configuration presence cannot establish delivery, inbox receipt, acknowledgement, or the
D1-independent path. The workflow itself sends one ordinary test email; it does not exercise
the runtime R2 outage ledger.

The [GitHub braces advisory](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm), read through
GitHub's advisory API on 2026-10-13, still lists `<= 3.0.3` and
`first_patched_version: null` (advisory updated `2026-10-02T22:36:34Z`). The accepted
shadcn development dependency exception therefore remains unresolved. Its exclusive expiry
is unchanged: **2026-10-17T00:00:00Z**. This reassessment neither extends the exception nor
bypasses the seven-day dependency policy.

## Remaining live evidence

- Confirm one test message in the existing operator inbox and record the receipt and
  acknowledgement UTC timestamps in the restricted release record. Provider acceptance
  alone is insufficient.
- Exercise the actual D1-independent R2 alert path under an approved, bounded fault scope.
  Do not disable the production database or mutate an active alert ledger merely to produce
  evidence. Local native R2 tests establish behavior but not production inbox delivery.
- Exercise one synthetic authority through detection, owner-scoped revocation, stale-authority
  refusal, recovery and cleanup under `docs/operations/security-response.md`. Keep real User
  data and live financial effects outside the exercise.
- Verify Cloudflare account budget and usage notification configuration against an approved
  monthly budget and observed Workers baseline. These are account-console settings, not
  repository-managed resources. Release success does not prove they exist.
- Cover edge/distributed refusal detection through a reviewed platform control. Per-isolate
  counters cannot claim complete low-rate, cross-isolate or cold-start observation.

The existing operator destination is available; no new recipient is proposed. The precise
production fault scope and approved monthly/model budgets are not recorded by the inspected
configuration. These missing inputs must not be replaced with fabricated evidence or an
unbounded exercise. Keep #1262 open until its observed-result requirements are met.

## Repository changes and validation

The existing presence signal now also observes exact Kapso/Wompi callback 400/422
refusals, MCP transport 4xx, and decoded canonical 4xx tool outcomes before MCP wraps
them in HTTP 200. The private adapters select the boundary. Every HTTP assembly and
User coordinator residency retains its own saturating counter and one outstanding-write
bound; all write the same fixed row and reuse the existing warning delivery policy.
There is no deployment-wide write cap. The [monitoring runbook](../operations/cloudflare-background-work.md)
records false-positive possibilities and the remaining coverage gaps.

Local validation, sequentially, without provider calls:

- Core HTTP/observer: 6 passed, including forged dimensions/path prefixes and callback 422.
- Native MCP residency: 18 passed, including canonical refusals inside HTTP 200,
  discovery exclusion and pressure refusal. This detection fixture substitutes canonical
  dispatch; it does not replace existing real-coordinator authorization tests.
- Full Operational Health directory: 48 passed in 10 files, including native D1/R2 alert
  admission, failed/ambiguous delivery, cooldown, acknowledgement and retention behavior.
- Edge-policy CLI regression: 2 passed, including refusal of a changed policy artifact.

The reviewed policy digest changes only because the Core response observer now classifies
these exact paths. Routing, credentials, authorization, public exposure and edge rules are
unchanged. These tests establish local behavior, not inbox receipt or a completed incident.
