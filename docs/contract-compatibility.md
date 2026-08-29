# Contract compatibility

`apps/server/src/shell/api.ts` owns `FidyApi`, the canonical operation declaration. The web
application consumes only `@fidy/server/client`; it does not own or copy an API contract.

## Derived server artifacts

Run `bun run contracts:generate` after changing the assembled API or reflected operation policy.
It deterministically writes:

- `apps/server/contracts/openapi.json` from `OpenApi.fromApi(FidyApi)`;
- `apps/server/contracts/operation-policy.json` from every catalog operation's identity and complete
  reflected policy value.

Object keys and operations are sorted before serialization. These files are review evidence and
base-revision inputs, not declarations. `bun run contracts:check:freshness` regenerates in memory and
fails if either committed file differs.

The policy artifact deliberately has no field allowlist. Its `policy` member is the complete
reflected JSON value, so a future access-requirement or policy variant becomes comparison evidence
without changing the checker.

## Pull-request comparison

`bun run contracts:check:compatibility` compares the candidate artifacts with `BASE_REF` (defaulting
to `origin/trunk`). The repository pins `@oasdiff-js/oasdiff-js`, and therefore its native `oasdiff`
binary, to detect structural OpenAPI breaks. Repository-owned comparison additionally rejects a
removed canonical operation or any nested change to an existing operation policy. Additive
operations remain compatible.

The architecture PR that introduces these artifacts has a one-time bootstrap path: when the base
revision has neither artifact, the checker archives that revision and runs the candidate-owned
pure generator against the base's `FidyApi`. A base containing only one artifact fails. Once both
artifacts are on trunk, comparisons consume the committed base artifacts whose own required gate
verified freshness.

Breaking findings fail closed. Every candidate server must remain compatible with the web currently
served in Production, and the candidate web must remain compatible with that candidate server.
Compatibility work uses two trunk releases. The first release may add a temporarily compatible
server shape and then, under the normal server-first ordering, promote the web that uses it. If web
promotion fails, the prior web remains compatible with that server. A later release may remove the
old server shape only after the adapted web is confirmed in Production.

That final removal may commit `apps/server/contracts/breaking-change-acknowledgement.json` with:

- the exact base contract digest;
- the exact candidate contract digest;
- the complete normalized finding set reported by the checker;
- a rollout issue URL in `B4rz99/fidy-ai`.

The acknowledgement is not permission to make the first release incompatible. In addition to exact
acknowledgement matching, the gate reads the public Production `deployment-metadata.json` and requires
its Git revision and contract digest to equal the pull-request base. The removal candidate may not
change `apps/web`, so the mandatory same-revision build exercises the deployed web source against the
candidate server declaration. These checks turn the promoted web artifact, rather than the rollout
issue alone, into removal evidence.

An acknowledgement fails as stale when there are no findings and cannot authorize a later contract
pair, a different finding, a simultaneous web adaptation, or removal based on a web release that has
not reached Production. Delete it after the removal reaches trunk.

## Repository verdict

`bun run verify` is the mandatory repository-owned pull-request verdict. It performs the clean
TypeScript project-reference build, generated-contract checks, dependency and architecture
enforcement, production builds, browser bundle checks, tests, quality gates, and the production-image
check when Docker is available. Database-backed server, observability, acceptance, and CRAP tests
join the same command when both `DATABASE_URL` and `MIGRATION_DATABASE_URL` are provided. CI provides
those values. Mutation testing is CI-owned: the pull-request gate excludes it, the nightly workflow
runs it explicitly, and the ungrouped local command does not select it. Provider-hosted secret, SAST,
and SCA scanners remain required sibling jobs because a local command cannot orchestrate them
meaningfully.

The project-reference build proves that the web compiles against the same-revision browser-safe
server declaration graph. OpenAPI comparison proves selected wire-shape compatibility. Neither can
detect a type-compatible semantic change—for example, returning a different meaning in the same
string field. Existing API-seam tests remain authoritative for request encoding, routing,
authorization, real handlers, PostgreSQL persistence, response encoding, and client decoding.

Production deploys the server before the web. One trunk release may **add and use** a temporarily
backward-compatible shape: Railway receives the server that accepts both forms before Cloudflare
promotes the web that uses the new form. Only after that web artifact is active may a later release
**remove** the old form. Do not combine use and removal in one release or treat the shared digest as
a substitute for rollout compatibility. See
[ADR 0018](adr/0018-independent-production-deployments.md) and the
[Production runbook](operations/production-releases.md).
