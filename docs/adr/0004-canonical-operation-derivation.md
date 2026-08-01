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
policy: path, status codes, required scope, Subscription tier, cost class, and hosted-agent
confirmation policy.

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
