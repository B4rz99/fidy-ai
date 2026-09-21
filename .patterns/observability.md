# Effect v4 observability at the Cloudflare boundary

Telemetry is a closed, provider-neutral metadata contract. Cloudflare logs, traces, metrics, and
alerts are adapters; core and domain code do not import an observability SDK.

## Work boundaries

Name meaningful work with `Effect.fn` or `Effect.withSpan` at the Worker, canonical operation,
Queue/Workflow activity, provider adapter, and parser boundaries. Use stable low-cardinality names.
Expected domain decisions are outcomes, not defects; classify provider failures, defects, interruption,
and resource exhaustion separately.

Propagation across Fidy-controlled Worker/service boundaries is explicit and bounded. Queue and
Workflow payloads may carry a schema-versioned trace correlation id only when the platform adapter
requires it. Public provider callbacks begin a new local trace unless a trusted Fidy boundary proves
continuation. Do not send Fidy trace headers to Kapso, Wompi, outbound Resend, or Workers AI unless an
approved provider contract requires it.

## Metadata-only policy

Allowed attributes are coarse operation/provider names, safe status classes, bounded latency, retry
count, resource-limit class, and model token counts when the Workers AI adapter exposes them. Never
attach UserId, email, phone, account/card values, transaction facts, raw errors, request/response
bodies, prompts, replies, tool inputs/results, credentials, URLs with query data, or provider payloads.

Errors are mapped to safe categories before telemetry. Redaction is not a substitute for an allowlist:
construct envelopes from approved fields rather than copying broad objects and deleting known secrets.
Metrics labels must remain low-cardinality and must not contain user or provider identifiers.

## Adapter and tests

The telemetry adapter receives the closed contract and fails safely if the Cloudflare sink is absent.
It must not change domain outcomes or provide persistence, retry, or authorization. Portable tests prove
projection, redaction, cardinality, and expected-outcome classification. Cloudflare adapter tests prove
metadata bounds, propagation policy, flush/shutdown behavior, and absence of personal content.
