# Test seams and the core mutation gate

- **Status:** Accepted
- **Date:** 2026-08-01

## Decision

Use the smallest seam that proves the behavior:

- **Core seam:** call pure domain decisions and schemas directly, with no shell or platform.
- **Contract seam:** derive OpenAPI, operation policy, and browser declarations from the canonical API
  and compare the generated artifacts.
- **Browser seam:** build the static Cloudflare artifact and exercise browser behavior with explicit
  HTTP fixtures; a fixture is not a production API authority.
- **Provider seam:** call the published outbound provider contract with bounded deterministic
  transport, preserving destination, credential, status, and redaction checks.
- **Cloudflare adapter seam:** when a Worker adapter exists, test D1, Durable Object, Queue, Workflow,
  R2, Email Worker, and Workers AI behavior through their platform bindings. Never recreate a deleted
  runtime with process-local state.

Core tests do not mock shell collaborators. Portable domain, schema, security, contract, provider,
and isolation evidence remains authoritative. Tests whose only owner was a removed runtime are
removed rather than replaced with a fake local authority.

## Consequences

Pure policy tests stay fast and deterministic, while platform integration tests prove the actual
Cloudflare boundaries. Generated contract checks catch drift between the server declaration and web
client. A test cannot claim persistence, redelivery, coordination, or model availability unless it
uses the corresponding Cloudflare adapter seam.
