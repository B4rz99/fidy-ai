# Server contract artifacts

`apps/server/src/shell/api.ts` owns `FidyApi`, the canonical operation declaration. The web
application consumes only `@fidy/server/client`; it does not own or copy an API contract.

## Derived artifacts

Run `bun run contracts:generate` after changing the assembled API or reflected operation policy. It
writes:

- `apps/server/contracts/openapi.json` from `OpenApi.fromApi(FidyApi)`;
- `apps/server/contracts/operation-policy.json` from every catalog operation's identity and reflected
  policy;
- `apps/server/contracts/pat-pairing-openapi.json` from the separate proof-bearing direct API.

These files are deterministic review evidence, not declarations. The canonical OpenAPI and operation
policy together produce the digest used by Production health and release metadata. `bun run contracts:check:freshness` fails if any committed artifact is stale.

## Prelaunch verification

`bun run verify` is the repository-owned verdict. It runs the TypeScript build, generated-contract
freshness, dependency and architecture enforcement, Cloudflare artifact builds, browser bundle
checks, portable tests, security checks, and quality gates. No database, local server, Docker image,
or process-local runtime is required or used.

The project-reference build proves that the web compiles against the same-revision browser-safe
server declaration graph. Portable core, schema, security, provider-boundary, and browser tests
provide behavioral evidence. There is no pull-request breaking-change gate against trunk: before
launch, older browser builds and PAT clients are not supported compatibility targets. A same-revision
build does not protect already-open browser tabs or independently updated clients. Define a support
window and check all client-facing API surfaces before those clients become supported.

Production deploys one exact-revision Cloudflare stack. The workflow rechecks trunk immediately
before deployment and verifies the deployed web metadata and API health response against that
revision and digest. See [the production runbook](operations/production-releases.md).
