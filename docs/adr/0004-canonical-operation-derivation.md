# Canonical operation derivation

- **Status:** Accepted
- **Date:** 2026-08-01

## Context

The server, typed client, OpenAPI document, MCP tools, and hosted-agent toolkit must describe the
same capability. Parallel endpoint, DTO, and tool definitions would drift and would make the
agent-facing contract difficult to trust.

At the same time, business schemas must not depend on HTTP paths, status codes, or transport
policy. A canonical domain model and a canonical operation definition therefore have different
homes.

## Decision

Declare the canonical schema for a domain entity in `core/<slice>/model.ts`. Declare the
canonical operation in `shell/<slice>/operations.ts`, where it contains its transport and access
policy: path, status codes, required scope, Subscription tier, cost class, hosted-agent
confirmation policy, and canonical query-or-mutation kind. See
[ADR 0027](0027-standalone-account-security-mutations.md) for mutation and atomic-batch eligibility.

The operation references the core schema. The assembled `FidyApi` is the source for reflected
operation ids, access metadata, suggested operations, OpenAPI, MCP definitions, and the hosted
agent toolkit. The hosted agent has no private operation map.

Every variant of a canonical shape is derived from its source schema. This includes extraction
schemas, response variants, and relational row projections. Money remains nested in domain and
canonical operation shapes; relational storage may flatten it into exact adjacent columns and
reconstruct it on read.

Suggested operations are call-safe: a non-empty suggestion is validated against the reflected
operation catalog and filtered by caller scope and tier before it reaches a response.

## Consequences

A capability is defined once for every generated surface, while HTTP knowledge stays out of core.
There is no transport DTO mapping layer to maintain and no parallel agent tool registry.

Operation definitions remain shell code even though constructing them is pure. The shell owns the
fact that a business capability is exposed through a particular transport and access policy.

## Rejected alternatives

### Put the entire operation definition in core

Rejected because URL paths, status codes, and delivery policy would enter business rules.

### Maintain separate domain models and transport DTOs

Rejected because every operation would need a mapping layer and the object used for derivation
would no longer be the canonical domain shape.

### Maintain a separate hosted-agent operation map

Rejected because it would allow the hosted agent surface to drift from the API and its access
policy.

## Assembly order and reflection

Add all groups before attaching API-wide middleware. Effect attaches middleware to the operations
already present. Telemetry wraps authorization and observes refusals as well as successful calls.
Authorization runs before validation so unauthenticated input is refused without decoding.

The catalog rejects duplicate ids and missing explicit access policy. Use the assembled endpoint
codecs for query and parameter decoding and use the JSON codec for bodies. Defer codec construction
until a consumer uses it so route and policy lookups do not initialize unrelated features. Bind the
response registry once after assembly. A distinct second assembly would change the policy and
codec behind an existing id, so it fails.

Suggestion filtering applies throughout the encoded response while preserving domain values and
exact decimal strings. A valid but unavailable operation is filtered by live scope and tier.
Malformed ids or arguments and more than three available suggestions indicate an invalid handler
response. Empty strict-object parameters use a never-valued record to admit no keys.

Keyword-rule browser-origin policy derives its stricter route family from the canonical collection
path so a newly added child inherits the gate.

Canonical success and expected refusal use the common top-level responses. Partial suggestions
retain the target operation's canonical codecs. Properties can be absent recursively. Arrays
keep cardinality, atomic declarations remain indivisible, and object checks wait only for omitted
required input. Browser and provider adapters share declared route patterns with the canonical
owner so edge policy cannot drift to a second path.
