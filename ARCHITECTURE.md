# Architecture

How fidy-ai is put together, and why.

---

## 1. System shape

The repository root is a private Bun workspace. It owns the single lockfile, CI, shared compiler
policy, repository-wide quality policy, and stable orchestration commands. Root commands deliberately
delegate application work to its owning workspace package: this gives contributors and automation one
repository entrypoint while keeping runtime dependencies and behavior inside the application that
owns them.

The workspace contains exactly two application packages: `@fidy/server` and `@fidy/web`.
`apps/server` is the `@fidy/server` application package. Its `src/` is layer-major:

- `core/` contains pure business decisions typed `Effect<A, E, never>` and touches no external
  service.
- `shell/` contains repositories, handlers, API assembly, adapters, and every other side effect.
- `apps/server/src/main.ts` is the only server production entrypoint. Command-level preloads may
  initialize process infrastructure before it, but cannot start application work. Scripts compose
  shell layers and contain no domain decisions.

`apps/web` is the `@fidy/web` React/Vite application package and produces a portable static artifact.
It owns browser routing, providers, styles, and public policy copy. Its only server import is the
browser-safe `@fidy/server/client` declaration seam; Effect Atom derives browser transport from that
canonical API without importing server implementations. The API process never serves web routes or
static assets.

The directory boundary is intentional. It is enforced by lint and dependency checks so a naming
convention cannot be mistaken for a purity boundary. A feature may touch both trees; that cost is
accepted in exchange for a structural boundary that survives refactoring and independent agent
sessions.

The API assembly imports slice operation definitions. Handlers import the assembled API as required
by the HTTP builder, and `http.ts` composes the handler layers. This direction is acyclic and is
protected by the dependency graph.

Server-specific build and deployment adapters live with `@fidy/server`. Its Dockerfile intentionally
uses the repository root as build context so Bun can install the one workspace lockfile, while the
runtime image receives only built server artifacts. Railway must use `/apps/server/railway.json` as
its config-as-code path; that adapter selects `apps/server/Dockerfile` without changing the repository
source root.

### Production topology

[ADR 0018](docs/adr/0018-independent-production-deployments.md) makes the application boundary a
runtime boundary. Railway builds and runs only the server image at `api.fidyapp.com`; Cloudflare
serves only the validated static web output at `fidyapp.com`. Cloudflare has no Worker entrypoint and
the API has no static-file route. The browser CSP permits connections only to the stable API origin.

GitHub Actions is the sole release coordinator. A trunk release selects one immutable source commit,
deploys it through Railway's connected-repository API, and verifies that public health reports its
full Git revision and canonical contract digest. Only then does it build an identically marked web
artifact, upload one immutable Cloudflare version, recheck trunk head, and promote that exact version.
The contract digest is derived from the checked-in server-owned canonical artifacts; the web still
consumes only `@fidy/server/client` rather than owning a copied contract.

Releases are serialized without cancelling an active deployment. A server failure stops before web
work. A web failure or superseded release leaves the prior Cloudflare version active; the newly
successful server remains temporarily compatible under the documented add/use/remove rollout. No
cross-provider rollback transaction exists. Provider source-triggered deployments are disabled, and
[the Production runbook](docs/operations/production-releases.md) owns configuration, diagnostics, and
recovery.

---

## 2. Slices and ownership

> **A slice owns data. A process coordinates slices.**

A process touching one slice's data lives inside that slice. A process that owns data nobody else
owns is a slice, including a pipeline. A process that owns no data is shell-only. A process never
writes another slice's tables; it calls the owning slice's operations so that invariants and
atomicity remain in one place. This rule applies to the nested WhatsApp operational slice: its
durable delivery state is WhatsApp-owned even though the surrounding channel area is shell
coordination.

Use three checks when drawing a boundary:

1. Data that must commit atomically belongs to one slice unless an accepted coordination decision
   says otherwise. ADR 0005 coordinates canonical state with Audit evidence, ADR 0009 coordinates
   initial User bootstrap, ADR 0008 serializes consent revocation with consent-dependent work, and
   ADR 0013 lets the deep WhatsApp disclosure-delivery module atomically coordinate verified
   attempt evidence with the Consent owner operation, and ADR 0017 coordinates PAT lifecycle with
   its append-only Consent evidence. These exceptions compose only owner-published operations and
   do not transfer data ownership.
2. Cross-slice references use stable ids, not embedded objects.
3. An invariant that must hold immediately is enforceable inside one slice.

A slice is not a bounded context or a use case. fidy is one bounded context with one vocabulary;
API groups are presentation choices.

### Core references

A core slice may import ownerless values from `core/_shared` or a sibling's narrow `reference.ts`.
A reference publishes only stable ids, stable compound identifiers, or kind codes that a genuine
sibling needs to name or persist. Mutable provider evidence is not a cross-slice reference. Core may
not import a sibling's model, rules, errors, taxonomy, repository, or other implementation. Shell
loads data and passes plain values to core decisions.

---

## 3. The functional core

Core code returns `Effect<A, E, never>`. The `never` requirement is the compiler-visible fence:
requesting a service stops compiling. Core takes time and generated ids as values; the shell
supplies them. Core decides; it does not gather data or perform I/O.

---

## 4. Canonical operation surface

The canonical schema for a domain entity lives in `core/<slice>/model.ts`. The canonical operation
lives in `shell/<slice>/operations.ts`, where transport and access policy belong: paths, status
codes, access requirement, Subscription tier, hosted-agent confirmation policy, and whether the
operation is a canonical query or canonical mutation. The access requirement is an algebra:
domain operations require one PAT scope, while account-security operations require a fresh web
session or a web-or-hosted caller.

A canonical query observes domain state without requesting a domain transition or external effect;
audit, quota, and access-accounting writes do not change that classification. A canonical mutation
requests a domain transition, records durable work, or causes an external effect. As decided in ADR
0012, every canonical mutation is transaction-composable by definition: its individual operation
and an atomic batch call the same reusable implementation inside a caller-owned, User-scoped
PostgreSQL transaction. The implementation does not open or commit an inner transaction. External
work is inserted as a durable job in that transaction and performed after commit when rollback
compatibility requires it.

The atomic-batch child union derives from every reflected canonical mutation and its encoded input
schema. There is no independent eligibility allowlist; the batch excludes itself structurally, and a
new mutation cannot ship without its reusable transaction-aware implementation.

ADR 0012 is adopted through an expand sequence. Operation kind records semantics immediately;
Transaction creation, correction, and deletion establish the implementation tracer, and the
remaining pre-existing mutations migrate in the follow-up slice issues linked from issue 137. The
batch operation remains unpublished until that migration is complete. During expansion, `kind` is
not an implementation-readiness flag.

The operation references the core schema. All public API and agent surfaces derive from the
canonical operation definition; parallel operation maps are not maintained.

The server-owned package has one browser-safe `@fidy/server/client` export backed by
`apps/server/src/client.ts`. It re-exports the assembled `FidyApi`, the client-side authorization
layer factory required by the middleware declaration, and genuinely useful derived types such as
`OperationId` and `CanonicalInput`. A web package derives its typed client directly from `FidyApi`
with `AtomHttpApi.Service()("FidyClient", { api: FidyApi, httpClient: ... })`; the facade does not
wrap transport or declare a second canonical surface. Its transitive browser build may reach core and
declaration-only operation modules, but not live middleware, repositories, handlers, workers, adapters,
observability implementations, database, filesystem, provider, or runtime modules. The browser build and module
graph guards are executable checks for that boundary.

### Web vertical composition

The web application is deliberately vertical rather than another flat shell:

- `src/main.tsx` only mounts `WebApplication`.
- `src/app/` is the composition root. `root-route.tsx` owns application chrome and not-found
  presentation; `routes.ts` composes that root with genuine feature interfaces, and
  `create-application.tsx` composes the route tree, transport, and session registry lifetime.
- `src/features/<feature>/feature.tsx` is the only public feature interface. A feature's private
  atoms, views, policies, and transport use stay in that feature; features never import one another.
- `src/transport/` is the only owner of `@fidy/server/client`. It derives the sole browser client
  from `FidyApi`; it does not introduce a parallel product client or server-state cache. Tests
  replace only the underlying `HttpClient` layer.
- `src/session/` owns a non-secret numeric authentication epoch and its explicit replacement
  transition. A changed epoch remounts `RegistryProvider`, so Atom server state cannot cross a
  future login, logout, or expiry. It does not own Atom state, TanStack Router state, or local
  React interaction state, and this issue does not implement pairing or web-session authentication.
- `src/ui/` contains ownerless visual primitives. They receive children and values and do not import
  application, feature, session, or transport code.

Dependency-cruiser rules and rejected-import probes enforce these arrows: app composes features,
session, and transport; session does not reach app or UI; and transport does not reach app, session,
UI, or features. The same checks enforce main's sole application import, reject generic dumping-ground
directories, enforce same-directory relative imports, cross-directory aliases, the non-importable
entrypoint, and the absence of barrels. The server-owned browser-client check is the sole transitive
allowlist for the facade and rejects server runtime modules or declaration modules outside that
allowlist. The web source-boundary check additionally rejects direct `fetch` calls, alternate
server-state or HTTP clients, and any web source entry into server code outside
`@fidy/server/client` through `src/transport/`.

The root TypeScript project-reference build expresses the server-before-web declaration dependency.
Server-owned OpenAPI and complete reflected operation-policy artifacts live under
`apps/server/contracts/`; they are deterministic review evidence, never another declaration. The
mandatory root gate checks freshness and compares them with the pull-request base, failing structural
or policy breaks unless an acknowledgement is bound to the exact base digest, candidate digest,
finding set, and coordinated rollout issue. See
[Contract compatibility](docs/contract-compatibility.md) for the artifact lifecycle and the
one-time base bootstrap used by the architecture PR that introduces them.

Every shape that differs from a canonical shape is derived from it. This includes extraction
schemas, response variants, and relational row projections. Money remains nested in domain and
canonical operation shapes; repositories may flatten it into exact adjacent columns and reconstruct
it on read. A type that never mentions the schema it derives from is a review smell.

A non-empty `SuggestedOperation` is validated against its target operation and filtered by caller
access and tier before it reaches a response. The operation checkpoint is the source of truth, not
a parallel tool map or a host-side parser.

OpenAI hosted-tool bindings derive one strict-mode wire codec from each canonical input schema.
Tools expose the canonical schema's encoded side so the provider applies strict adaptation exactly
once; returned arguments are normalized from either strict wire form or the provider's
canonical-encoded form before canonical re-encoding. This returns OpenAI's required-nullable
optional properties to canonical absence. A raw strict JSON Schema paired with an unadapted decoder
is invalid: it can advertise `null` values that its own handler rejects.

### Hosted-turn continuity

Hosted turns coordinate three deep shell modules under [ADR 0014](docs/adr/0014-deep-hosted-turn-modules.md):

- HostedInference alone converts, completely measures, and executes opaque provider requests.
- WorkingContext alone constructs the trusted-policy-first semantic context order and projects
  persisted prose as untrusted User material.
- ConversationContinuity alone owns explicit Turn lifecycle, exact retained Transcript,
  complete-prefix Compaction, optimistic replacement, and physical deletion.

The legal sequence is continuity preparation and recovery, one WorkingContext construction, complete
hosted preflight, stale-snapshot-checked Turn admission, prepared execution, delivery without replay,
and explicit terminalization. Production startup submits separately framed 15K Memory, 15K
CompactedConversation, approximately 100K exact Transcript, and 16K active-request token maxima
through that same complete preparer, with every canonical tool and the 16K output reserve. The active
request also retains its independent 16K-character storage bound and is never silently truncated.
Provider state, model or tokenizer identity, context capacity, prompt fragments, and constructible
executable authorities do not cross these public boundaries. The executable contract, named test
evidence, and implementation-ticket ownership live in the
[agent-continuity invariant matrix](docs/architecture/agent-continuity-invariant-matrix.md); its
completeness and every configured credential path are enforced by
`bun run check:continuity-invariants`.

### Browser authentication and PAT lifecycle

ADR 0015 replaces WhatsApp-delivered web login links with browser-initiated pairing at
`/auth/pair`. The browser retains the private verifier and WhatsApp sees only a public code that
cannot establish a session. Pairing expires after ten minutes and succeeds once. Security-sensitive
web actions require pairing completed within the preceding ten minutes; passkeys are deferred under
the accepted MVP threat model.

ADR 0016 makes `/settings/pats` the only PAT-issuance authority. Manual issuance reveals the raw PAT
once to the first-party browser; PATPairing returns it once directly to the initiating client that
retained the private device code. WhatsApp may list safe PAT metadata, answer bounded activity
questions, and revoke PATs, but cannot issue or approve them and never transports a PAT, private
proof, or bearer-equivalent link. ADR 0017 commits each PAT grant or revocation with its ConsentRecord
through owner-published operations in one User-scoped transaction.

---

## 5. User context and isolation

`UserId` is an explicit argument to every repository function and every core function that needs
user context. The caller is resolved at the adapter boundary and passed inward. There is no ambient
`CurrentUser` service. PostgreSQL row-level security reinforces that explicit boundary: each short
User-owned transaction establishes transaction-local context through the restricted runtime role.
Migrations use a separate authority, and narrow deny-by-default gateways resolve pre-subject bearer
or authenticated identity without exposing general privileged SQL. WhatsApp authorization resolves
only the trusted Business Portfolio plus authenticated BSUID pair; phone, username, and parent BSUID
remain mutable evidence and cannot resolve or reassociate a User.

Ordinary aggregates carry no owner field: the user is the context in which an operation runs.
`ConsentRecord` and `AuditLogEntry` carry an explicit subject because they attest who acted.

Isolation is guarded by a test derived from the assembled `HttpApi`: seed two users, enumerate
every canonical operation, and assert that one user's data is neither visible nor mutable to the
other. Background jobs and ingestion paths pass the user explicitly as well. The WhatsApp durable queue
claims only the work identity and stable User through a narrow gateway, then processes it in a
separate User-scoped transaction; no database transaction spans model or provider network work.
A scheduled no-input gateway removes expired ingress budgets and free-form windows without exposing
or accepting identifiers.

A User's current ServiceMarket, locale, and IANA time zone are explicit independent context. An
existing record is not reinterpreted when current User preferences change; artifacts that need
later interpretation retain the relevant context at creation.

Authorization is the auditing boundary for every reflected canonical operation. Resolved calls
record metadata-only audit entries; unresolved bearers create no invented evidence. Successful
state and success evidence share a database transaction, while rejection and failure evidence
survives the operation transaction. ADR 0008 additionally keeps the subject Consent lock across
PAT or HostedTurnToken use renewal and canonical execution so revocation is linearizable with authorized work.
Hosted-model context is loaded after the same serialized consent decision, but the provider call
starts only after that short database transaction commits.

Every canonical operation declares hosted-agent confirmation policy. A confirmation for a risky
operation is bound to the exact operation and canonical input, is single-use, and is recoverable
only from the eligible recent Transcript turn. The hosted agent does not infer authority from
phrases outside that policy.

---

## 6. Errors and external effects

Core failures are `Data.TaggedError` values and contain no HTTP vocabulary. API failures are
schema-backed tagged error classes because they are encoded into response bodies and must remain
selectively catchable in-process. Their `_tag` is omitted on encoding: the closed `code` field is the
wire discriminator. Each slice has one exhaustive core-to-API mapper in shell. Core never needs to
know which transport exposes it.

External providers stay at shell edges behind narrow services. Launch-specific behavior remains
in its owning module rather than being hidden behind speculative provider or market registries.
The WhatsApp edge authenticates bounded exact webhook bytes before decoding and bounds Kapso
response bytes before SDK decoding. Its worker appends a visible assistant Transcript entry only
after provider delivery succeeds; failed or ambiguous sends do not claim that the User saw a reply.

---

## 7. Persistence

Migrations are one globally ordered database history, stored in `shell/db/migrations/` and composed
through an explicit index. The numbering is global because foreign keys cross slices and the
migrator applies one sequence.

Relational rows are projections of core models, not parallel domain models. Repositories flatten
nested Money only where storage and queries require it, then decode and reconstruct the canonical
value on every read. Ordinary totals remain derived rather than persisted.

PostgreSQL advisory-lock keys are namespaced by the owning slice and protected resource before
hashing. The one deliberate shared key is the bare UserId used by WhatsApp enqueue admission and
turn claim: those two steps coordinate the same per-User queue invariant. Lock APIs fuse lock
acquisition with the protected body and transaction, so a transaction-scoped lock cannot silently
be acquired and released before its work runs.

Postgres returns `jsonb` as decoded JSON, so relational projections decode the bare column rather
than casting it through text. Global query/result name transforms remain waived: adopting them
would require a repository-wide alias audit, and recursive JSON transforms could alter domain
keys; the current explicit aliases keep that boundary local. Insight Money groups use one bulk
insert per event. LISTEN/NOTIFY remains deferred until the WhatsApp worker restructure tracked by
#135; polling stays the correctness fallback, so changing wake-up transport independently would
add a second scheduling mechanism without removing the first.

---

## 8. Testing seams

Use these seams:

- **Core seam:** exported pure decisions, with no server or database.
- **API seam:** operation decoding, authorization, handlers, repositories, and real PostgreSQL.
  It proves persistence, responses, suggested operations, and per-user isolation.
- **Agent seam:** `AgentService.handleTurn` through the CLI harness, with external language-model
  and terminal adapters substituted while the canonical application path remains real.
- **Channel-worker seam:** the exported durable worker step with real Consent, Identity, RLS
  repositories, and AgentService; only language-model and provider clients are substituted.
- **Public-channel acceptance seam:** the signed provider webhook over a real socket, real PostgreSQL,
  and the production Identity, Consent, queue, worker, AgentService, and canonical operation path;
  only the provider transport and language-model behavior are substituted. This seam owns named
  end-to-end channel scenarios and a separate source-coverage ratchet.

Core tests do not mock repositories or handlers. They prove decisions directly; the API seam proves
load-decide-persist integration. A stable pure policy may be tested directly, but its integration
still needs API-seam coverage. Caller-resolution boundaries may use concrete persistence observers
when they protect data that must remain absent from public responses.

The core mutation gate requires every in-scope behavioural mutant to be killed. Exact scope,
exclusions, runner, and coverage settings belong in the test configuration rather than here. The
shell retains its coverage and CRAP gates.
