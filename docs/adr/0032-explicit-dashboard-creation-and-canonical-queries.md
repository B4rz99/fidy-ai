# Explicit Dashboard creation and canonical queries

- **Status:** Accepted
- **Issues:** #967, #968 (prerequisites of #32)

## Decision

`dashboard.getDashboard` and `dashboard.getDashboardView` are canonical queries requiring `read`.
They observe one User's existing validated document or complete ephemeral view, never create a
DashboardDocument, edit financial facts, repair a projection, or advance a document revision.
This supersedes the former implicit first-use creation promise.

The Dashboard shell contract declares `DashboardUninitialized`: HTTP 404 with
`error.code: "dashboard_uninitialized"`, a safe actionable message, and the universal `next` field.
Only genuine document absence produces it. Runtime absence remains `Option`; corrupt documents,
unreadable dependencies, and incomplete projections return unavailable rather than absence or a
partial total. Initialized success contracts remain the complete document/view schemas.

`dashboard.initializeDashboard` is the explicit idempotent canonical mutation requiring `dashboard`.
It returns an existing document unchanged; concurrent initialization preserves its Widget identities,
content and revision. It and edits retain the shared atomic unit and document-child collision policy.
Queries are excluded from batch-child schemas through the canonical kind derivation, not a separate
operation exclusion list. A catalog-derived guard requires every operation available to a read-only
PAT to be a query. Kind never relaxes caller eligibility, scope, live credential or Consent checks.

## Execution and web first use

HTTP and hosted execution use the same substantive native Dashboard query implementation. Document
queries retain the per-User coordinator through validated projection assembly and live accounting,
preventing concurrent Correction from splitting a snapshot. Exact Currency/direction separation,
current IANA-zone interpretation and the readiness guarantees of ADR 0030 remain unchanged.
Credential-use and required metadata-only Audit writes are query accounting, not domain mutation.
Existing bounded canonical/Worker Work observation is sufficient; no telemetry purpose is added.

The authenticated web's Effect Atom owner explicitly composes read → initialize → read, solely in
response to the declared uninitialized failure. Initialization and second-read failures propagate
truthfully; there is no recursive initialization or infrastructure-error fallback. Workflow phase
feedback distinguishes initialization from reading the initialized result. Concurrent tabs rely on
the initializer's idempotence, not browser authority or local state. Retry is explicit and bounded to
one initialization attempt per load; a later retry reads authoritative state again.

## Evidence boundary

Focused Worker/D1/coordinator tests cover absence, corruption, initialized identity/revision
preservation, read-only PAT refusal with no partial effects, two-User isolation and exact snapshots.
Built-web journeys cover existing/fresh/concurrent first use and initialization/read refusals.
These are local/emulated acceptance evidence, not a Production deployment or live provider claim.
