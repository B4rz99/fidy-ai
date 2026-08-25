# Server architecture

This document owns the internal architecture of `@fidy/server`. Read the repository
[`ARCHITECTURE.md`](../../ARCHITECTURE.md) first for system shape, cross-application contracts,
production topology, and browser-to-server ownership.

---

## 1. Application shape

`apps/server` is the `@fidy/server` application package. Its `src/` is layer-major:

- `core/` contains pure business decisions typed `Effect<A, E, never>` and touches no external
  service.
- `shell/` contains repositories, handlers, API assembly, adapters, and every other side effect.
- `src/main.ts` is the only production entrypoint. Command-level preloads may initialize process
  infrastructure before it, but cannot start application work. Scripts compose shell layers and
  contain no domain decisions.

The API assembly imports slice operation definitions. Handlers import the assembled API as required
by the HTTP builder, and `http.ts` composes the handler layers. This direction is acyclic and is
protected by the dependency graph.

Server-specific build and deployment adapters live with `@fidy/server`. Its Dockerfile intentionally
uses the repository root as build context so Bun can install the one workspace lockfile, while the
runtime image receives only built server artifacts. Railway must use `/apps/server/railway.json` as
its config-as-code path; that adapter selects `apps/server/Dockerfile` without changing the repository
source root.

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
   verified onboarding bootstrap, ADR 0008 serializes consent revocation with consent-dependent
   work, ADR 0013 lets the deep WhatsApp disclosure-delivery module atomically coordinate verified
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

Cross-operation coordination that owns no data stays in its shell area as a named implementation
module rather than being forced into `queries.ts` or `mutations.ts`. Atomic batch execution therefore
lives in `shell/operations/atomic-batch.ts`: HTTP handlers and canonical registries are peer adapters
that delegate to it and never import one another.

The operation references the core schema. All public API and agent surfaces derive from the
canonical operation definition; parallel operation maps are not maintained.

The package has one browser-safe `@fidy/server/client` export backed by `src/client.ts`. It
re-exports the assembled `FidyApi`, the client-side authorization layer factory required by the
middleware declaration, and genuinely useful derived types such as `OperationId` and
`CanonicalInput`. Its transitive consumer graph may reach core and declaration-only operation
modules, but not live middleware, repositories, handlers, workers, adapters, observability
implementations, database, filesystem, provider, or runtime modules. Browser-build and module-graph
guards are executable checks for that boundary.

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

Hosted turns run inside the hosted agent runtime, whose whole public seam for callers is
`AgentService.handleMessage` — one inbound message in, one delivered reply out
([ADR 0019](../../docs/adr/0019-hosted-runtime-owns-conversation-continuity.md)). Behind it are three deep
shell modules under [ADR 0014](../../docs/adr/0014-deep-hosted-turn-modules.md):

- HostedInference alone converts, completely measures, and executes opaque provider requests.
- WorkingContext alone constructs the trusted-policy-first semantic context order and projects
  persisted prose as untrusted User material.
- ConversationContinuity alone owns explicit Turn lifecycle, exact retained Transcript,
  complete-prefix Compaction, optimistic replacement, and physical deletion. It is a private helper
  of the runtime rather than a boundary a peer coordinates with, fenced by a module-graph rule whose
  exact arms ADR 0019 records.

The legal sequence is continuity preparation and recovery, one WorkingContext construction, complete
hosted preflight, stale-snapshot-checked Turn admission, prepared execution, delivery without replay,
and explicit terminalization. Production startup submits separately framed 15K Memory, 15K
CompactedConversation, approximately 100K exact Transcript, and 16K active-request token maxima
through that same complete preparer, with every canonical tool and the 16K output reserve. The active
request also retains its independent 16K-character storage bound and is never silently truncated.
Provider state, model or tokenizer identity, context capacity, prompt fragments, and constructible
executable authorities do not cross these public boundaries. The tests in the ordinary suite are the
contract; every configured credential path additionally needs its own named evidence, enforced by
`bun run check:credential-evidence`.

### Browser authentication, recovery, and PAT lifecycle

ADR 0015 replaces WhatsApp-delivered web login links with browser-initiated pairing at
`/auth/pair`. The browser retains the private verifier while WhatsApp approval, email
authentication, and support recovery receive only the proof each authority needs; none can establish
a session without the browser proof. Pairing expires after ten minutes and succeeds once.
Security-sensitive web actions
require pairing completed within the preceding ten minutes; passkeys are deferred under the
accepted MVP threat model. The hosted Kapso delivery attempt and direct-browser redemption emit
only registry-closed operation, outcome, safe reason, retry, HTTP status, attempt, and latency
coordinates. They never project the private verifier, public code, bearer, cookie, URL, reply text,
UserId, request/response payload, User prose, or domain data.

[ADR 0020](../../docs/adr/0020-mandatory-verified-email-authentication-and-recovery.md) makes one
VerifiedEmailCredential a prerequisite to stable User creation. EmailAuthentication owns pre-User
mailbox verification attempts, the User's single credential, and Resend delivery state; Recovery
owns the digest-only BackupRecoveryCode and tracked support cases. Identity still owns User,
WhatsAppIdentity, and TrialPeriod facts; Consent still owns pending decision evidence and
ConsentRecords. The shell-only onboarding completion process composes those owners under ADR 0009
and creates all stable onboarding state only after email proof succeeds.

Email authentication and support recovery approve an existing BrowserLoginPairing for the existing
UserId. They do not create a parallel session, create another User, replace the
VerifiedEmailCredential, or change WhatsAppIdentity. The browser's private verifier remains
necessary to create the WebSession. A User
whose Consent is explicitly revoked may authenticate only to reach Fidy-owned re-consent and
data-rights surfaces; ordinary canonical work remains blocked with `user_action_required`.

ADR 0016 makes `/settings/pats` the only PAT-issuance authority. Manual issuance reveals the raw PAT
once to the first-party browser; PATPairing returns it once directly to the initiating client that
retained the private device code. WhatsApp may list safe PAT metadata, answer bounded activity
questions, and revoke PATs, but cannot issue or approve them and never transports a PAT, private
proof, or bearer-equivalent link. Manual issuance offers 7, 30, 90, and 365-day fixed lifetimes,
records one reviewed absolute expiration, and never changes that expiration on successful use.
ADR 0017 commits each PAT grant or revocation with its ConsentRecord through owner-published
operations in one User-scoped transaction.

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
survives the operation transaction. Hosted Agent Session admission serializes the current Consent basis without holding a transaction
across inference or delivery. That basis governs the active session until 15 minutes of inactivity;
terms updates wait for the next session, while explicit revocation prevents another Turn without
interrupting one already admitted. User-owned agents never manage Consent: terms updates neither
revoke nor block PATs, while explicit revocation prevents subsequent PAT work with
`user_action_required`.

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
Resend is EmailAuthentication's launch outbound-email adapter; it receives only the recipient and bounded
message projection required for the current proof, and provider work is driven by durable delivery
state. The WhatsApp edge authenticates bounded exact webhook bytes before decoding and bounds Kapso
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
- **Agent seam:** `AgentService.handleMessage` through the CLI harness, with external language-model
  and terminal adapters substituted while the canonical application path remains real.
- **Hosted execution-boundary seam:** `makeAgentToolkit` and `executeHostedCanonicalOperation`
  driven directly against real PostgreSQL. `AgentService.handleMessage` cannot reach a refused
  canonical call, because its own preflight never issues a mismatched permit, so this seam is the
  only place the refusal paths, their audit evidence, and their all-or-nothing rollback are
  observable.
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
