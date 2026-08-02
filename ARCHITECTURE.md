# Architecture

How fidy-ai is put together, and why.

---

## 1. System shape

`src/` is layer-major:

- `core/` contains pure business decisions typed `Effect<A, E, never>` and touches no external
  service.
- `shell/` contains repositories, handlers, API assembly, adapters, and every other side effect.
- `src/main.ts` is the only production entrypoint. Scripts compose shell layers and contain no
  domain decisions.

The directory boundary is intentional. It is enforced by lint and dependency checks so a naming
convention cannot be mistaken for a purity boundary. A feature may touch both trees; that cost is
accepted in exchange for a structural boundary that survives refactoring and independent agent
sessions.

The API assembly imports slice operation definitions. Handlers import the assembled API as required
by the HTTP builder, and `http.ts` composes the handler layers. This direction is acyclic and is
protected by the dependency graph.

---

## 2. Slices and ownership

> **A slice owns data. A process coordinates slices.**

A process touching one slice's data lives inside that slice. A process that owns data nobody else
owns is a slice, including a pipeline. A process that owns no data is shell-only. A process never
writes another slice's tables; it calls the owning slice's operations so that invariants and
atomicity remain in one place.

Use three checks when drawing a boundary:

1. Data that must commit atomically belongs to one slice unless an accepted coordination decision
   says otherwise. ADR 0005 coordinates canonical state with Audit evidence, ADR 0009 coordinates
   initial User bootstrap, and ADR 0008 serializes consent revocation with consent-dependent work.
   These exceptions compose only owner-published operations and do not transfer data ownership.
2. Cross-slice references use stable ids, not embedded objects.
3. An invariant that must hold immediately is enforceable inside one slice.

A slice is not a bounded context or a use case. fidy is one bounded context with one vocabulary;
API groups are presentation choices.

### Core references

A core slice may import ownerless values from `core/_shared` or a sibling's narrow `reference.ts`.
A reference publishes only stable ids or kind codes that a genuine sibling needs to name or
persist. Core may not import a sibling's model, rules, errors, taxonomy, repository, or other
implementation. Shell loads data and passes plain values to core decisions.

---

## 3. The functional core

Core code returns `Effect<A, E, never>`. The `never` requirement is the compiler-visible fence:
requesting a service stops compiling. Core takes time and generated ids as values; the shell
supplies them. Core decides; it does not gather data or perform I/O.

---

## 4. Canonical operation surface

The canonical schema for a domain entity lives in `core/<slice>/model.ts`. The canonical operation
lives in `shell/<slice>/operations.ts`, where transport and access policy belong: paths, status
codes, scopes, Subscription tier, cost class, and hosted-agent confirmation policy.

The operation references the core schema. All public API and agent surfaces derive from the
canonical operation definition; parallel operation maps are not maintained.

Every shape that differs from a canonical shape is derived from it. This includes extraction
schemas, response variants, and relational row projections. Money remains nested in domain and
canonical operation shapes; repositories may flatten it into exact adjacent columns and reconstruct
it on read. A type that never mentions the schema it derives from is a review smell.

A non-empty `SuggestedOperation` is validated against its target operation and filtered by caller
scope and tier before it reaches a response. The operation checkpoint is the source of truth, not
a parallel tool map or a host-side parser.

---

## 5. User context and isolation

`UserId` is an explicit argument to every repository function and every core function that needs
user context. The caller is resolved at the adapter boundary and passed inward. There is no ambient
`CurrentUser` service. PostgreSQL row-level security reinforces that explicit boundary: each short
User-owned transaction establishes transaction-local context through the restricted runtime role.
Migrations use a separate authority, and narrow deny-by-default gateways resolve pre-subject bearer
or phone evidence without exposing general privileged SQL.

Ordinary aggregates carry no owner field: the user is the context in which an operation runs.
`ConsentRecord` and `AuditLogEntry` carry an explicit subject because they attest who acted.

Isolation is guarded by a test derived from the assembled `HttpApi`: seed two users, enumerate
every canonical operation, and assert that one user's data is neither visible nor mutable to the
other. Background jobs and ingestion paths pass the user explicitly as well. A future background queue
claims only the work identity and stable User through a narrow gateway, then processes it in a
separate User-scoped transaction; no database transaction spans model or provider network work.

A User's current ServiceMarket, locale, and IANA time zone are explicit independent context. An
existing record is not reinterpreted when current User preferences change; artifacts that need
later interpretation retain the relevant context at creation.

Authorization is the auditing boundary for every reflected canonical operation. Resolved calls
record metadata-only audit entries; unresolved bearers create no invented evidence. Successful
state and success evidence share a database transaction, while rejection and failure evidence
survives the operation transaction. ADR 0008 additionally keeps the subject Consent lock across
AgentToken renewal and canonical execution so revocation is linearizable with authorized work.
Hosted-model context is loaded after the same serialized consent decision, but the provider call
starts only after that short database transaction commits.

Every canonical operation declares hosted-agent confirmation policy. A confirmation for a risky
operation is bound to the exact operation and canonical input, is single-use, and is recoverable
only from the eligible recent Transcript turn. The hosted agent does not infer authority from
phrases outside that policy.

---

## 6. Errors and external effects

Core failures are `Data.TaggedError` values and contain no HTTP vocabulary. API failures are
`Schema.ErrorClass` values because they are encoded into response bodies. Each slice has one
exhaustive core-to-API mapper in shell. Core never needs to know which transport exposes it.

External providers stay at shell edges behind narrow services. Launch-specific behavior remains
in its owning module rather than being hidden behind speculative provider or market registries.

---

## 7. Persistence

Migrations are one globally ordered database history, stored in `shell/db/migrations/` and composed
through an explicit index. The numbering is global because foreign keys cross slices and the
migrator applies one sequence.

Relational rows are projections of core models, not parallel domain models. Repositories flatten
nested Money only where storage and queries require it, then decode and reconstruct the canonical
value on every read. Ordinary totals remain derived rather than persisted.

---

## 8. Testing seams

Use these seams:

- **Core seam:** exported pure decisions, with no server or database.
- **API seam:** operation decoding, authorization, handlers, repositories, and real PostgreSQL.
  It proves persistence, responses, suggested operations, and per-user isolation.
- **Agent seam:** `AgentService.handleTurn` through the CLI harness, with external language-model
  and terminal adapters substituted while the canonical application path remains real.

Core tests do not mock repositories or handlers. They prove decisions directly; the API seam proves
load-decide-persist integration. A stable pure policy may be tested directly, but its integration
still needs API-seam coverage. Caller-resolution boundaries may use concrete persistence observers
when they protect data that must remain absent from public responses.

The core mutation gate requires every in-scope behavioural mutant to be killed. Exact scope,
exclusions, runner, and coverage settings belong in the test configuration rather than here. The
shell retains its coverage and CRAP gates.
