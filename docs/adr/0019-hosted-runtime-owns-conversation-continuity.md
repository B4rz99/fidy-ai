# The hosted agent runtime owns conversation continuity

- **Status:** Accepted
- **Date:** 2026-08-19

## Context

[ADR 0014](0014-deep-hosted-turn-modules.md) replaced distributed hosted-Turn policy with three deep
modules and left `AgentService` as "a coordinator over the three boundaries". Its public contract
allowed prepared continuity context and mutation authorities to cross the module seam: "trusted
shell callers may reuse them while their attempt is active", and "prepared requests and mutation
authorities are bound to the adapter, User, revision, or Turn that created them and are rejected
when stale or already consumed".

Coordination is what made those rules necessary. Because a prepared attempt and a Turn lifecycle
handle were returned from `ConversationContinuity` into `AgentService`, the caller could retain one
past its validity, and every retention had to be defeated at runtime: generation counters,
capability scopes, claim-once registries, and supersession checks on every mutation. That machinery
was a large share of the module's surface and of its tests, and it defended against a state the
caller was structurally able to reach.

Issue #281 replaced `HostedTurnToken` with deep Hosted Agent Sessions. A Hosted Agent Session is
durable, bounded by a 15-minute idle boundary, and captures the exact onboarding Consent basis. With
durable session state, once-only Turn terminalization no longer needs an in-memory capability at
all: it is a property of the row, checked inside the same transaction that mutates it.

## Decision

The hosted agent runtime owns conversation continuity lexically. `AgentService` exposes exactly one
public operation:

```ts
handleMessage: <E, R>(
  userId: UserId,
  message: InboundMessage,
  deliver: (reply: AgentReply) => Effect.Effect<void, E, R>
) => Effect.Effect<AgentReply, AgentTurnError | E, R>;
```

One inbound message in, one delivered reply out. Session admission, Turn admission, inference,
complete hosted preflight, canonical execution, delivery, and terminalization all happen inside that
call.

This supersedes ADR 0014's coordinator wording. Its HostedInference, WorkingContext, and Memory
decisions stand unchanged.

- **Persistence stays in private helpers.** `ConversationContinuity` remains a module and a service;
  it is now a private helper of `src/shell/agent`, not a boundary a peer coordinates with. It
  exposes data-only operations — observe, lock, admit a session, require a session, prepare a Turn,
  admit a Turn, append, complete, fail — and PostgreSQL remains concrete behind it.
- **No lifecycle handle crosses the seam.** A prepared attempt, a Turn authority, and the inferred
  Turn lifecycle handle do not leave the runtime. The `Turn` lifecycle scope is constructed and
  consumed within one lexical flow, so ordering is guaranteed by the flow rather than checked.
- **Once-only terminalization becomes durable, not capability-bound.** Every append and every
  terminalization requires the Turn to still be Pending in the same transaction that changes it. A
  second terminalization is refused by the row, across processes and across restarts — a strictly
  stronger guarantee than an in-memory generation counter, which protected only one process.
- **The mutable cross-module capability disappears.** Capability scopes, generation counters,
  claim-once registration, and supersession checks are deleted rather than relocated. Nothing
  reproduces them inside the runtime.
- **Durable Pending Turn state remains** for abandoned-work recovery. The next preparation still
  recovers an abandoned Pending Turn as Interrupted.
- **A module-graph rule enforces the boundary.** `continuity-reached-outside-hosted-runtime` in
  `apps/server/.dependency-cruiser.mjs` rejects every import of the Conversation Continuity, Hosted
  Agent Session, or Transcript-service operations except from `src/shell/transcript` itself, from
  `src/shell/agent/agent-service.ts`, and from a test colocated under `src/shell/agent`. Production
  code inside the runtime directory is no more privileged than code outside it: `agent-service.ts`
  is the single production importer, so a sibling of the runtime is rejected like any other module.
  Probes in `scripts/check-dependency-guards.ts` prove each arm — rejection from outside, rejection
  from a runtime sibling, rejection of a test that is not colocated, and admission of one that is.
  A type carries no capability, so type-only imports stay legal. Core models under
  `src/core/transcript` are the shared vocabulary and stay importable, and so is
  `transcript/repo.ts`, which is how a test asserts on committed rows without holding the seam.

The legal hosted-Turn sequence in ADR 0014 still describes what happens, with two corrections: the
serialization authority is acquired by the runtime rather than handed to it, and step 4's `beginTurn`
revision comparison is the runtime's own admission step, reached only after complete hosted preflight
succeeds. Preparation retries remain bounded to three before failing closed.

## Consequences

The seam is smaller and the invariants are stronger. A caller cannot hold a Turn authority because
no Turn authority is reachable; a stale terminalization is refused by durable state rather than by a
counter that a restart resets. The deleted supersession tests were tests of a mechanism, not of a
behavior — the behavior they protected is now covered by durable Pending checks.

The runtime module is larger, and `handleMessage` is the only way to exercise hosted behavior from
outside. Tests reach continuity directly only from inside `src/shell/agent` or from continuity's own
test, which the module-graph rule permits and enforces.

Terminalization is durable but its evidence is sequential: `withUserTurnLock` serializes a User's
hosted work, so no test drives two concurrent transactions at one Turn. The row-level guarantee is
the mechanism; the test proves the sequential case.

Recovery of an abandoned Pending Turn happens after session admission, not before it, so admission
sees the Turn still Pending. A Pending Turn counts as activity from when it started rather than
exempting the session from the boundary: admission evaluates the boundary while holding the Turn
lock, so any Pending Turn it observes was abandoned by an interrupted holder rather than in flight.
Exempting one would let an arbitrarily old session resume and then stamp a fresh terminal time
during its own recovery, rolling forward forever on nothing but that repair — and a session that
never idle-ends is an onboarding Consent basis that never refreshes. Recovery is User-scoped
rather than session-scoped, so the abandoned Turn is still terminalized once the next preparation
runs, under whichever session admission chose.

This supersedes the originating issue's wording that a Pending Turn keeps its session active. That
clause is redundant for a Turn in flight, which already holds the Turn lock that admission needs,
and wrong for the only Pending Turn admission can observe, which is abandoned by construction. This
ADR is the authority where the two disagree. It also keeps the existing `AgentService` name where
the issue says `HostedAgentRuntime`: the requirement is the one-`handleMessage` seam, and renaming
the service would churn every caller without changing that seam.

Terminalization covers defects as well as declared failures. A refused canonical call reaches the
runtime as a defect, so generation is captured as an `Exit` rather than a `Result` and a Turn that
ends in a defect is Failed. Interruption still leaves the Turn Pending without an explicit branch,
because an interrupted fiber never reaches terminalization at all.

Session admission owns the committed close of a session whose Consent was revoked. A close sharing a
transaction with the refusal that follows it is rolled back, so the mid-Turn recheck only refuses:
admission closes the stale session and opens a fresh one against current Consent. That is what keeps
one-active-session-per-User from refusing every later message once a User re-grants.

## Rejected alternatives

- **Collapse every module into one file.** Rejected: the seam that mattered was the public one.
  Continuity persistence, compaction inference, and session rows are cohesive private units, and
  fusing them into the runtime file would trade one large surface for one large file.
- **Keep the coordinator and validate handles harder.** Rejected: this is what ADR 0014 did. Each
  new mutation needed a new supersession check, and the checks protected against a reachable state
  instead of removing it.
- **Keep the capability machinery inside the runtime.** Rejected: within one lexical flow the
  ordering it enforced is already guaranteed, so it would be dead defense with live cost.
- **Adopt the `PreparedHostedInvocation` sketch from `reports/issue-281/`.** Rejected: like ADR
  0014's treatment of `reports/issue-11/`, that sketch is a decision input, not an accepted
  interface. It models complete-response preflight as an array of closures holding each
  implementation and permit, but the model's tool calls are dispatched by wire name through
  `AgentToolkit.toHandlers`, so a closure array cannot be what executes. The implementation instead
  correlates a permit to its call through a closure-owned FIFO ledger keyed by exact operation and
  exact canonical input, with a single-use permit consumed inside the canonical transaction and an
  `isExecutionActive` gate on both offer and execution. That yields the invariant the sketch was
  reaching for — no sibling executes if any call in the response is rejected, and a permit is
  spendable only by the exact input it was issued for — without handing an executable to the model's
  dispatcher.
- **Enforce the boundary by convention only.** Rejected: a rule a tool could enforce but no tool
  runs is not a standard (CODING_STANDARDS.md), so the fence is a module-graph rule with probes.
