# Contract compatibility

`apps/server/src/shell/api.ts` owns `FidyApi`, the canonical operation declaration. The web
application consumes only `@fidy/server/client`; it does not own or copy an API contract.

## Derived artifacts

Run `bun run contracts:generate` after changing the assembled API or reflected operation policy. It
writes:

- `apps/server/contracts/openapi.json` from `OpenApi.fromApi(FidyApi)`;
- `apps/server/contracts/operation-policy.json` from every catalog operation's identity and reflected
  policy.

The files are sorted, deterministic review evidence and base-revision inputs, not declarations.
`bun run contracts:check:freshness` regenerates them and fails if either committed file differs.

## Pull-request comparison

`bun run contracts:check:compatibility` compares candidate artifacts with `BASE_REF` (defaulting to
`origin/trunk`). Structural OpenAPI changes and removed canonical operations fail closed. Additive
operations remain compatible. A one-time bootstrap handles a base revision that predates both
artifacts; once both are on trunk, comparison uses the committed base artifacts.

A breaking-change acknowledgement, when required, is bound to the exact base digest, candidate
digest, normalized finding set, and rollout issue. It is not permission to bypass a stale artifact or
to deploy a web build against a different declaration.

## Repository verdict

`bun run verify` is the repository-owned verdict. It runs the TypeScript build, generated-contract
checks, dependency and architecture enforcement, Cloudflare artifact builds, browser bundle checks,
portable tests, security checks, and quality gates. No database, local server, Docker image, or
process-local runtime is required or used.

The project-reference build proves that the web compiles against the same-revision browser-safe
server declaration graph. OpenAPI comparison proves selected wire-shape compatibility; it cannot
detect a type-compatible semantic change. Portable core, schema, security, provider-boundary, and
browser tests remain the semantic evidence for those boundaries.

Production uses one exact-revision Cloudflare version. The workflow uploads the immutable candidate,
rechecks trunk immediately before promotion, and leaves the prior version active if the candidate was
superseded. See [the production runbook](operations/production-releases.md).
