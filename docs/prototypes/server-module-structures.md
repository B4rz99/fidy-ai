# Server module structure prototype

_Throwaway Design It Twice artifact for [Compare radically different server module structures](https://github.com/B4rz99/fidy-ai/issues/574), under [Redesign the server source architecture](https://github.com/B4rz99/fidy-ai/issues/571). This records alternatives and human reactions; it is not the target architecture specification._

## Question

What materially different structures could organize `apps/server/src` while preserving all fixed constraints, and which structures remain credible after comparison with the human?

Fixed constraints:

- `core/` and `shell/` remain the compiler-visible functional-core / imperative-shell split.
- `shell/api.ts` remains the canonical declaration assembly landmark.
- Aggregates own their data and immediate invariants.
- Cross-owner coordination sequences only owner-published operations.
- Direct `src/` becomes a closed composition and publication root.
- Generic buckets such as `common/`, `utils/`, `services/`, `orchestration/`, and `infrastructure/` are not acceptable.
- Domain behavior, canonical public contracts, Effect, and the server/web boundary do not change.

The alternatives use the module-design vocabulary of **module**, **interface**, **seam**, **adapter**, **depth**, **leverage**, and **locality**.

## Evidence the alternatives must explain

[Research established structures for a DDD functional-core server](https://github.com/B4rz99/fidy-ai/issues/572) found support for cohesive domain modules, deliberately narrow shared concepts, owner-respecting application coordination, explicit composition roots, and mechanically enforced public/private seams.

[Measure where the current server architecture loses locality](https://github.com/B4rz99/fidy-ai/issues/573) measured the concrete pressure:

- 48 direct cross-owner repository imports;
- `shell/_shared` mixing canonical assembly, policy, mechanisms, and owner-specific helpers;
- `core/_shared` mixing ubiquitous values with plausibly owned concepts;
- direct `shell/` files already forming latent Cluster, durable-execution, and maintenance modules;
- direct `src/` files imported inward rather than acting as a closed root;
- legitimate high-fan-out hotspots that must remain explicit, including `shell/api.ts`, `shell/http.ts`, migration registration, `AgentService`, bounded external HTTP, persisted-queue policy, and the broad API harness.

## Alternative A: Published Trio

The lean alternative keeps owner directories mostly flat. A module may publish at most three conventional files:

```text
shell/<module>/
├── contract.ts       # declarations callers may inspect
├── operations.ts     # behavior other server modules may invoke
├── runtime.ts        # Effect Layers composition may install
└── ...               # implementation private by graph rule
```

The files are optional. A module without a public declaration has no `contract.ts`; one without separately composed Layers has no `runtime.ts`.

Named cohesive modules replace structural ambiguity:

```text
shell/
├── canonical/
├── cluster/
├── durable-execution/
├── maintenance/
├── outbound-http/
├── onboarding/
├── browser-authentication/
└── dashboard-view/
```

Cross-owner imports may target only `contract.ts` or `operations.ts`; composition may additionally import `runtime.ts`. Dependency-cruiser rules and executable positive/negative probes make every other cross-owner import invalid.

**Advantages:** least ceremony, clearest migration path, low file movement, and familiar enforcement.

**Main risk:** privacy is mechanically real but not always visually obvious because private implementation remains alongside the published files.

## Alternative B: Owner Capsules with Named Mechanisms

This alternative gives every substantial owner an explicit public/private shape:

```text
shell/consent/
├── interface/
│   ├── consent-authority.ts
│   └── consent-ledger.ts
├── internal/
│   ├── repo.ts
│   └── locks.ts
└── adapters/
    └── http.ts
```

Interface granularity is intentionally non-uniform. Consent may warrant several deep interfaces because subject locking, append-only evidence, and pending exchanges have different invariants. Agent may retain only its already-deep `AgentService` interface. Small owners are not required to imitate large ones.

A published operation hides repository details, RLS activation, lock ordering, row reconstruction, and immediate invariants. Cross-owner coordinators can invoke it without gaining access to the owner's persistence primitives.

**Advantages:** ownership and privacy are visually obvious; the shape encourages deep, intention-revealing interfaces and strong locality.

**Main risk:** `interface/`, `internal/`, and `adapters/` can become ceremony or role buckets when imposed on shallow modules.

## Alternative C: Canonical Spine, Sealed Owners

This alternative optimizes the most common canonical-operation trace. Each canonical operation becomes a vertical directory:

```text
shell/canonical/transactions/create-transaction/
├── contract.ts
├── execute.ts
└── api.test.ts
```

Execution then calls published owner capabilities:

```text
transactions.createTransaction
  → Categories.findReferenceInScope
  → Identity.readUserContextInScope
  → Transactions.createInScope
```

Owner persistence remains sealed under owner-private directories. HTTP, hosted execution, agent tools, and atomic batch share one immutable canonical implementation publication.

**Advantages:** given an operation id, its contract, execution, test, and owner calls are adjacent and easy to trace. It removes the current `operations.ts → handlers.ts → queries.ts/mutations.ts → repo.ts` navigation chain.

**Main risk:** it makes canonical operations the primary organizing axis even though workers, provider ingress, maintenance, and hosted processes are equally important. It also risks many tiny directories and shallow adapter chains.

## Alternative D: Sealed Publication Lattice

The strongest-enforcement alternative treats each cohesive owner or mechanism as an internal source package and TypeScript composite project:

```text
shell/identity/
├── package.json
├── tsconfig.json
├── identity.ts
├── canonical.ts
├── canonical-live.ts
├── runtime.ts
└── private/
    └── repo.ts
```

A reviewed `module-graph.ts` would generate package dependencies, export maps, TypeScript references, dependency-cruiser rules, browser-safe closure checks, and enforcement probes. The import graph would never generate its own permissions.

Repository bypass would fail at several independent layers: package exports, TypeScript project inclusion, package dependency declarations, removed broad aliases, and dependency-cruiser.

**Advantages:** strongest mechanically non-bypassable publication seam and clearest declared dependency lattice.

**Main risk:** many manifests, declaration builds, and tool integrations. Bun, Vitest, coverage, mutation testing, source maps, and production builds would all need additional project/package support. The cost is disproportionate unless ordinary graph rules prove insufficient.

## Shared result across all four alternatives

Every exploration independently converged on these points:

1. Both `_shared` directories should disappear through deliberate classification, not wholesale renaming.
2. Direct `src/` should contain only launch, composition, publication, and ambient declarations.
3. Cross-owner repository access should be replaced by intention-revealing owner operations.
4. A published `*InScope` operation must join the caller's existing User transaction, preserve RLS and lock state, write only owner data, and never independently commit.
5. Repositories remain plain functions over `SqlClient`; no repository ports or repository services are introduced.
6. Ports and adapters remain limited to genuinely remote-owned or true-external behavior.
7. Retention decisions remain with owners; Maintenance owns cadence and best-effort sequencing only.
8. `shell/api.ts`, `shell/http.ts`, `main.ts`, migration registration, canonical implementation publication, `AgentService`, and the broad API harness remain explicit legitimate hotspots.
9. Cross-module tests use published interfaces, while owner-private fixtures and crash runners move beside their owners.
10. Named cohesive mechanisms should hold canonical execution, bounded provider HTTP, persisted-queue policy, durable execution, Cluster runtime, and other complexity that earns a deep module.

## Comparison

| Criterion | Published Trio | Owner Capsules | Canonical Spine | Publication Lattice |
|---|---|---|---|---|
| Obvious ownership | Good | Best | Good | Best |
| Enforceable dependencies | Good | Very good | Very good | Strongest |
| Locality | Good | Best | Mixed | Very good |
| Module depth | Good | Best | Mixed | Very good |
| Honest coordination | Good | Best | Good | Very good |
| Canonical-operation navigation | Good | Good | Best | Good |
| Migration tractability | Best | Good | Moderate | Lowest |
| Visual tidiness | Best | Moderate | Lowest | Moderate |

## Human-confirmed narrowing

The human confirmed three recommendations for the later architecture-selection decision:

1. **Keep the hybrid as the leading contender.** Published Trio provides the default shape; explicit `internal/` makes privacy visible; a module may publish additional named interfaces only when their depth justifies the added surface.
2. **Keep owner navigation primary.** Canonical-operation navigation remains important, but it should not become the global source-tree axis because it does not organize workers, maintenance, ingestion, provider ingress, or hosted processes as honestly as ownership does.
3. **Use dependency-cruiser plus executable probes as the expected enforcement mechanism.** The package/project lattice is a fallback only if a required publication rule cannot be reliably expressed with the existing graph tooling.

The resulting contender is:

```text
shell/<owner-or-named-module>/
├── contract.ts       # optional browser-safe/canonical declaration interface
├── operations.ts     # small, substantive callable interface
├── runtime.ts        # optional composition interface
└── internal/         # private implementation and repositories
```

The roles are:

- `contract.ts`: what the module promises;
- `operations.ts`: what another server module may ask it to do;
- `runtime.ts`: how composition constructs or starts it;
- `internal/`: how it works, unavailable across module seams.

This narrowing is not yet the selected target architecture. [Choose the target server module architecture](https://github.com/B4rz99/fidy-ai/issues/575) owns that decision and may refine or reject the contender after deeper grilling.
