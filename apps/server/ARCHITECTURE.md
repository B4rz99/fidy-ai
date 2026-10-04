# Server architecture

Read the repository [`ARCHITECTURE.md`](../../ARCHITECTURE.md) first. This document owns the
high-level boundaries of `@fidy/server`. Domain meaning belongs in [`GLOSSARY.md`](../../GLOSSARY.md),
security invariants in [`SECURITY_STANDARDS.md`](../../SECURITY_STANDARDS.md), and implementation
contracts beside their owners.

## 1. Application shape

`apps/server` owns the canonical domain, operation contracts, and Cloudflare application adapters.
It has no production process listener.

| Area            | Responsibility                                                                      |
| --------------- | ----------------------------------------------------------------------------------- |
| `src/core/`     | Business decisions and schemas, without platform requirements                       |
| `src/shell/`    | Canonical declarations, policy, provider-neutral contracts, and portable adapters   |
| `cloudflare/`   | Worker entrypoints, native adapters, D1 migrations, and platform evidence           |
| `contracts/`    | Generated OpenAPI and operation-policy evidence, not independent declarations       |
| `src/client.ts` | The sole outward browser/CLI-safe declaration publication; no server implementation |

Cloudflare is the sole Production runtime. D1 owns application state, Durable Objects coordinate
per-User work, Queues redeliver bounded identities, Workflows execute durable steps, and R2 retains
private bytes. Workers AI is the only Fidy-controlled inference platform. An absent adapter fails
closed; neither a declaration nor a binding proves an executable path. See
[ADR 0026](../../docs/adr/0026-cloudflare-native-production-replatform.md).

### Composition roots

- The public ingress Worker owns edge HTTP policy and forwards through a service binding; it has
  no D1 binding.
- `cloudflare/core-worker.ts` composes private HTTP, Queue, and Maintenance runtimes and publishes
  the deployed Durable Object and Workflow identities.
- The existing per-User Durable Object owns serialization and alarms. It constructs Agent and
  inference services where needed; merely declaring an AI binding on Core does not construct them.
- The private Email Worker composes only its narrow Ingestion and Maintenance capabilities.
- `infra/cloudflare` owns deployment topology and resource wiring, not domain behavior.

Roots compose published owner interfaces and never become inward-facing implementation facades.
Portable code cannot import native implementations; the native dependency graph remains acyclic.

## 2. Ownership and publication

An owner exposes only the Published Trio interfaces it earns:

- `contract.ts`: schemas, meaning, and inert declarations;
- `operations.ts`: substantive behavior and deliberate public projections;
- `runtime.ts`: construction and fixed-policy runtime authority.

Other files are owner-private, including visible `internal/` modules. Cross-owner imports—including
types, tests, scripts, tools, and infrastructure—use published interfaces. Contracts do not depend on
operations or runtime; private implementation does not import its own outward operations/runtime.
A wrapper must own behavior rather than expose private functions, storage rows, or provider shapes.

Runtime construction belongs to explicit composition roots, runtime interfaces and their private
implementation, and approved tool/integration compositions. A test or harness filename grants no
additional access. The pure Shared Kernel is limited to `core/_shared/money.ts`, `context.ts`, and
`time.ts`; shell helpers have named owners rather than a generic shared bucket.

Dependency and publication checks enforce the resolved graph; browser bundle checks independently
bound the client graph. Semantic leakage through an otherwise legal interface still requires review.
See root architecture's public-surface review and
[ADR 0031](../../docs/adr/0031-published-owner-interfaces-and-visible-internals.md).

## 3. Canonical contracts and execution

`src/shell/api.ts` assembles the canonical API from owner declarations.
`shell/canonical-catalog/contract.ts` reflects that graph; batch schemas derive from it before the
batch group is assembled. HTTP clients, OpenAPI, operation policy, SuggestedOperations, MCP
projections, and hosted tools share the same operation identities and input/output codecs.
Generated artifacts are review evidence, not alternate registries.

Canonical Policy owns discovery and execution policy. Native Canonical Operations coordinates
catalog-bound execution through owner operations; its dispatch and adapter registries remain
private. HTTP and hosted callers share installed-query selection and invocation, including
Transaction-history selection and observational Budget reads. Alert reconciliation belongs to
coordinated Budget/Transaction mutation execution, never query invocation. HTTP retains transport
admission and the original request for owner input classification; hosted canonical arguments reconstruct only their
declared route. Both cross the same invocation seam, which binds the declared capability and preserves
owner refusals, live accounting and interruption. Removing Canonical Operations would redistribute
this invocation knowledge across callers rather than remove it.

Canonical Operations sends HTTP Dashboard document/view queries through the existing per-User
coordinator for every input form. A query admission contains only a catalog-bound path/query target
plus the caller's credential proof, never transport headers or bearer plaintext. The coordinator
rejects foreign subjects, mutation identities and substituted targets before invoking a query owner.
Hosted queries execute inside their already held Turn coordination. Agent retains Turn, confirmation
and Transcript behavior; domain owners retain their substantive implementation and authority.
Tokens' installed PAT-metadata query consumes the admitted caller proof instead of reauthenticating
from transport cookies. Its D1 snapshot rechecks the exact WebSession digest, User, lifetime and
Consent for both the safe metadata read and Audit; PAT callers cannot manage their own credentials.
Individual and batch mutations keep their existing execution. Discovery does not grant execution
authority, and unavailable operations never fall back to a different path.

The direct browser/proof transports described in root architecture remain separate: credential
bootstrap, statement-byte staging, hosted conversation/delivery, and payment enrollment. They are
not tools or atomic-batch children. `src/client.ts` publishes their intended declarations without
native implementation. Server implementations consume owners directly, not through this client facade.
Contract checks establish freshness; prelaunch compatibility with older revisions is not a gate.

Hosted MCP/OAuth remains a design, not an installed authority. Its planned OAuth caller must enter
the same canonical policy and User coordinator without becoming a PAT, WebSession, or Hosted Agent
Session. [ADR 0033](../../docs/adr/0033-hosted-mcp-and-oauth-agent-grants.md) owns that decision.

## 4. Subject, proof, and provider boundaries

Every protected operation carries an explicit User. Authentication supplies subject-correlated
premises for live rechecking, not a reusable permission token. A provider id, Queue identity,
Durable Object key, or anonymous source digest cannot authorize a User. Credential, Consent, scope,
and owner-state guards participate in the authoritative action or atomic unit.

Browser Login alone initiates one-use WebSession establishment, requiring both approval and the
browser-private verifier. Email proof, WhatsApp approval, and Recovery cannot independently mint a
session or change the stable User association. Onboarding composes verified owner state atomically
but does not issue a WebSession. Tokens owns the distinct PAT/PATPairing lifecycle; bearer plaintext
is disclosed only at issuance/claim, while server persistence retains verification evidence.

Consent owns current standing and append-only evidence. A standing read is not cached authorization.
Ordinary protected work checks current Consent. An exact Pending hosted Turn retains its admitted
Consent basis for bounded completion; revocation prevents the next Turn. Model egress still passes
through the Consent-owned boundary, and PAT work retains its per-call guard.

`shell/outbound-http` is the raw outbound provider transport boundary for Kapso/Meta, Wompi, and
outbound Resend. It owns fixed destinations, credentials, redirects, byte bounds, and safe failures.
Provider adapters consume its published contract. HostedInference instead uses the direct Workers AI
binding behind a provider-neutral contract and approved-model/conformance gates, with no external
model fallback. Kapso voice transcripts are external channel material, not Fidy-controlled inference.

Telemetry is allowlisted metadata only. Audit is a separate owner of accountability evidence and
transaction-composable recording; peers supply subject/credential proofs, not Audit persistence
shapes. Secrets, personal content, provider bodies, and raw failures stay out of telemetry and public
error projections.

## 5. State and atomicity

The canonical mutation unit composes owner-prepared work into one User-scoped D1 commit, including
live authority, credential accounting, and Audit. Individual and batch execution share that unit.
Child operations do not independently commit or make provider calls; batch preparation cannot assume
it sees earlier children's writes. Unsupported children fail closed rather than partially executing.
See [ADR 0029](../../docs/adr/0029-atomic-batch-accountability-boundaries.md).

Coordination and storage are complementary: the User Durable Object serializes work, while D1 guards
recheck authority, revision, and eligibility at commit. A pending-Turn mutation fence prevents a
foreign, terminal, or already-consumed hosted call from committing. No process lock or post-commit
repair substitutes for these guards.

R2 bytes and D1 state cannot commit together. Statement staging is authenticated, bounded, opaque,
and non-authoritative. Canonical publication verifies ownership, size, and digest and commits the
submission, accounting, staging promotion, and extraction intent together. Unpublished material
expires; authoritative submissions cannot reference missing or mismatched bytes. See
[ADR 0028](../../docs/adr/0028-statement-bytes-are-staged-outside-atomic-batches.md).

A D1 commit and external submission are also separate effects. Durable outbox intent plus idempotent
handoff bridges that boundary. Provider uncertainty belongs to the owner's retained lifecycle and
reconciliation policy; timeout or lost acknowledgment is not proof of rejection.

### Domain authority and cross-owner relationships

| Owner                            | Architectural responsibility                                                                             |
| -------------------------------- | -------------------------------------------------------------------------------------------------------- |
| Identity                         | Stable User, WhatsAppIdentity, original TrialPeriod, and historical UserContext                          |
| Consent                          | Processing permission and append-only evidence; protected-action composition                             |
| WebSession / Browser Login       | Live browser credential authority / pairing and one-use establishment                                    |
| Email Authentication / Recovery  | Mailbox proof and replacement / same-User recovery approval, not session issuance                        |
| Tokens                           | PAT/PATPairing scope, proof, issuance, activity, revocation, and expiry                                  |
| Transactions / SourceAttestation | Effective financial facts and corrections / immutable captured-source declarations                       |
| Categories                       | Stable taxonomy and User keyword rules; rule changes affect future capture, not retained history         |
| Budgets                          | Exact spending and threshold decisions over Transactions' published effective contributions              |
| Dashboard                        | Validated documents and views composed from published Category, Budget, and Transaction facts            |
| Ingestion                        | Bounded material admission, interpretation, Transaction-or-review finalization, and retention            |
| Subscription                     | Prices, PaymentEnrollment, BillingAttempts, and settled paid periods                                     |
| AccessTier                       | Data-free decision from Identity's original TrialPeriod and Subscription's settled paid interval         |
| Quotas                           | Independent commercial consumption and live meter projections, separate from resource protection         |
| Recurring                        | Historical charge-pattern evidence and immutable confirmations, not billing or delivery                  |
| Insights                         | Scheduled occurrences, lifecycle, and delivery evidence over published historical facts                  |
| Memory                           | Current User-owned prose and aggregate capacity, without a revision history or embedding authority       |
| Agent                            | Hosted Session/Turn lifecycle, context, confirmation, inference orchestration, and Transcript settlement |
| WhatsApp                         | Authenticated channel evidence, send claims, delivery certainty, and channel recovery                    |
| Audit                            | Accountability evidence, recording budgets, and bounded retention                                        |

Peers receive decoded projections or deliberate commit-composition operations, never another owner's
rows, effective SQL relation, provider representation, or reusable credential authority.
Web Authentication and Onboarding coordinate these owners without acquiring independent state.

Financial projections preserve exact Money, Currency separation, effective Transaction semantics,
and historical context. Dashboard/Budget reads cannot turn incomplete or changed-revision facts into
partial totals. Write-maintained projection and repair requirements belong to
[ADR 0030](../../docs/adr/0030-dashboard-exact-write-maintained-projection.md).
Dashboard queries do not create or edit documents; explicit initialization and edits share canonical
mutation execution under
[ADR 0032](../../docs/adr/0032-explicit-dashboard-creation-and-canonical-queries.md).
Recurring consumes Transaction-owned facts and invalidation under its
[design ADR](../../docs/adr/0032-deterministic-recurring-charge-detection.md).

Payment enrollment requires fresh browser authority and Consent and stays outside canonical/PAT
access. Transient payment authorization material goes directly from the browser to Wompi. Paid Pro
requires independently verified matching settlement, not authorization or PaymentSource availability.
AccessTier is derived at the decision instant, never persisted as a separate authority. See
[ADR 0021](../../docs/adr/0021-browser-only-payment-credential-enrollment.md).

## 6. Hosted execution and delivery

Agent constructs one deep service inside the existing User coordinator. It privately owns context,
Compaction, confirmation, bounded inference, canonical execution, delivery, and terminalization.
A soft HTTP deadline cannot release serialization before owner settlement or durable recovery.
Progress observation does not start a second Turn or bypass canonical tool policy.

An accepted User entry and Pending Turn are retained atomically. A generated reply is a delivery
proposal, not yet Transcript evidence. Agent commits exact assistant content and Completed status
only from authenticated visible-delivery evidence: a browser receipt or the channel's authoritative
signed evidence. Provider send acceptance alone does not complete a Turn. Ambiguous sends are not
blindly retried, and unconfirmed delivery remains truthfully unconfirmed.

WhatsApp publishes inert delivery/status evidence; it does not receive an Agent terminalization
callback or read Turn/Transcript persistence. Memory supplies only the current same-User projection.
Transcript storage, confirmation records, and Compaction replacement remain Agent-private.

Durable Object alarms recover abandoned work and enforce retention; an independent Core sweep
recovers missed alarms without waiting for another User request. Retention removes private content
under owner policy while preserving permitted lifecycle metadata, never extending expired authority.

## 7. Background execution and availability

Queue and Workflow payloads carry bounded, versioned identities/facts rather than credentials,
financial content, prompts, or raw material. Consumers assume redelivery and recheck current owner
state. Queue acknowledgment proves handoff, not provider delivery or domain completion.

Post-commit request continuations accelerate publication but are not its durability mechanism.
Scheduled recovery reoffers eligible intent and reconciles uncertainty. Maintenance composes owner
runtimes for independent dispatch, reconciliation, and retention: one failure does not skip unrelated
activities, while interruption preserves cleanup. Maintenance owns no SQL, retention policy, domain
aggregate, provider execution, or authorization.

Operational Health observes bounded owner metadata and dead-letter signals separately from public
reachability health. Unreadable measurements are unavailable, not zero. Operational procedures and
limits belong in the [background-work runbook](../../docs/operations/cloudflare-background-work.md).

Installed code does not by itself enable a channel or provider. In particular, forwarded-email
routing remains disabled until institution Connection admission and authenticated institutional
sender proof exist. Receipt/image acceptance atomically publishes commercial consumption,
accountability, visible review, and an identity-only outbox; provider retrieval/extraction is not
installed. Accepted images therefore remain visibly extraction-unavailable, with bounded
locator/caption retention. Rejected images retain no deferred bytes and admit no hosted Turn.
[Commercial allowances](../../docs/operations/commercial-allowances.md) document the separate
accounting boundaries. Deployment configuration and owner contracts remain the evidence for
executable capabilities, not this document's directory inventory.

## 8. Evidence and test boundaries

- Core tests prove schemas and business decisions without platform bindings.
- Contract tests prove canonical reflection, policy, codecs, and generated-artifact freshness.
- Provider tests replace the published transport below real request/response policy.
- Browser tests distinguish presentation fixtures from real public/Core Worker journeys.
- Cloudflare tests prove actual D1 atomicity, User isolation, Durable Object coordination, R2
  ownership, Queue redelivery, Workflow behavior, and restart/retention semantics at the relevant seam.
- Live provider gates establish behavior that local fixtures cannot prove, including Workers AI
  conformance. Activity tests alone do not prove platform suspension or production alert delivery.

Tests may inspect their own visible internals; foreign tests use published contracts and operations.
Owner fixtures stay private. Explicit broad native integration compositions may construct actual
runtime bindings but gain no foreign-private access. Fixtures isolate state, schema, objects, and
coordinators across cases; cached immutable setup data is not shared application state. Migration
and runtime-lifecycle evidence must exercise the actual boundaries rather than infer them from a
faster ordinary fixture.

Verification combines dependency/publication checks, generated contracts, browser graph checks, and
behavioral evidence. Passing a fake or portable test never establishes a production adapter's
existence, durable guarantees, or launch readiness.
