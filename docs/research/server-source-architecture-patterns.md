# Established structures for a DDD functional-core server

_Research snapshot: 2026-09-13. Ticket: [#572](https://github.com/B4rz99/fidy-ai/issues/572), under map [#571](https://github.com/B4rz99/fidy-ai/issues/571)._

## Question and scope

Which established architecture patterns and primary-source guidance can help structure Fidy's TypeScript modular monolith while preserving all of these fixed constraints?

- `core/` and `shell/` remain the compiler-visible purity split; `shell/api.ts` remains a shell architectural landmark.
- An aggregate owns its data and immediate invariants.
- Cross-slice orchestration owns sequencing only and can use only operations published by an owner.
- A named cohesive module may exist when it hides real complexity; generic role buckets are rejected.
- Public contracts, domain behavior, Effect, and the server–web boundary do not change.

This report compares applicable ideas. It deliberately **does not choose a target source architecture**. That choice belongs to later Design It Twice work.

## Executive synthesis

No single cited pattern exactly describes Fidy's required combination. The sources are most useful as independent design tests:

1. **Functional Core / Imperative Shell** explains the non-negotiable purity axis: the core calculates values; the shell performs I/O from those values.
2. **DDD Modules and Aggregates** explain the ownership axis: modules should name cohesive domain concepts, while aggregate boundaries locate synchronous invariants and transactional consistency.
3. **Service Layer / application coordination** explains an execution axis: a stable application-facing operation coordinates a response without taking another aggregate's rules or persistence.
4. **Process Manager** is a narrower pattern for stateful, dynamically sequenced work. It should not become the name for every function that invokes two owner operations.
5. **Modular Monolith plus package-by-component/feature** explains locality and encapsulation inside one deployable, but a wholesale feature-major top level would contradict Fidy's retained `core/`–`shell/` landmark. Its ideas can still be compared as a nested organization.
6. **Composition Root** explains where the final Effect Layer graph belongs, not where ordinary orchestration or domain behavior belongs.
7. **Enforceable module interfaces** turn the intended dependency graph into executable policy. This is necessary but insufficient: a graph checker can prevent forbidden imports, but it cannot decide whether a purportedly shared concept is ownerless or whether a coordinator has absorbed business rules.

The strongest common warning is against confusing a folder taxonomy with encapsulation. Evans treats modules as model concepts, Brown distinguishes organization from encapsulation, and Shopify's experience says merely moving files by domain did not isolate dependencies. A replacement architecture therefore needs both meaningful module interfaces and enforced import/data-ownership rules—not a new `shared/`, `services/`, `use-cases/`, or `application/` catch-all.

## Baseline: what is already fixed in Fidy

These are repository facts and ticket constraints, not conclusions imported from the literature.

- The server is currently layer-major: pure `Effect<A, E, never>` decisions are in `core/`; repositories, handlers, adapters, assembly, and other effects are in `shell/`; `src/main.ts` is the sole production entrypoint (`apps/server/ARCHITECTURE.md:14-27`).
- Fidy is one bounded context. A slice is neither a bounded context nor an API group. The ownership rule is “a slice owns data; a process coordinates slices”; processes cannot write another slice's tables, cross-slice references use stable ids, and immediate invariants must be enforceable within one owner (`apps/server/ARCHITECTURE.md:30-49`).
- Core can import ownerless values from `core/_shared` or a sibling's narrow `reference.ts`, but not sibling models, rules, errors, taxonomy, or implementation (`apps/server/ARCHITECTURE.md:51-55`).
- Purity is already more precise than a folder label: core requires no Effect service, while the shell supplies time, ids, context, loaded state, and I/O (`apps/server/ARCHITECTURE.md:57-62`).
- `shell/api.ts` already assembles every canonical operation under shared validation, authorization, and telemetry and is the declaration from which server, typed client, and OpenAPI derive (`apps/server/src/shell/api.ts:41-50`). No redesign may duplicate or move that contract.
- The existing production composition is explicit: `src/main.ts` supplies runtime, database, HTTP, durable execution, observability, and logging Layers to `AppLive`, then launches the result (`apps/server/src/main.ts:1-22`).
- Fidy intentionally uses plain repository functions and reserves `Context.Service` for something that must be constructed or substituted. Core remains plain functions (`CODING_STANDARDS.md:139-155`). A pattern comparison must not smuggle repository interfaces or class-shaped “services” into the design merely because an OO source uses them.
- Security constrains possible seams: every User-owned access carries an explicit `UserId`; canonical-operation policy applies across HTTP, hosted agent, MCP, CLI, and suggestions; non-request paths must preserve isolation (`SECURITY_STANDARDS.md:100-122`). An owner interface that drops this context would be architecturally neat and security-invalid.

## 1. Functional Core / Imperative Shell

### Sourced guidance

Gary Bernhardt's original **Functional Core, Imperative Shell** description uses a functional core to manage and render values, surrounded by imperative code for stdin/stdout, a database, and a network. He calls out two resulting properties: functional pieces are easy to test without test doubles, and the imperative shell tends to have fewer conditionals because decisions have moved into the core ([Destroy All Software, “Functional Core, Imperative Shell”](https://www.destroyallsoftware.com/screencasts/catalog/functional-core-imperative-shell)). His related **Boundaries** talk emphasizes simple values as the interfaces between subsystems and connects that choice to functional programming, mutation, isolation, and concurrency ([Destroy All Software, “Boundaries”](https://www.destroyallsoftware.com/talks/boundaries)).

Eric Evans' DDD Reference gives compatible but independently motivated guidance: isolate domain model and business logic from infrastructure, UI, and application-task management; it explicitly says layered or hexagonal arrangements are useful only insofar as they preserve that isolation ([DDD Reference](https://www.domainlanguage.com/wp-content/uploads/2016/05/DDD_Reference_2015-03.pdf), p. 10). Alistair Cockburn's original Hexagonal Architecture article likewise identifies the fundamental asymmetry as inside versus outside, with technology-specific adapters translating purposeful interactions across ports ([Cockburn, “Hexagonal Architecture,” 2005](https://alistair.cockburn.us/hexagonal-architecture)).

### Applicability to Fidy

**Application-specific conclusion.** FC/IS directly supports keeping `core/` and `shell/` as the fixed top-level axis. It also supports passing decoded values, clocks, ids, and loaded state into a pure decision rather than introducing a port for every repository call. Fidy's `Effect<A, E, never>` fence is a TypeScript/Effect-specific enforcement of the source pattern, not a claim made by Bernhardt.

**Application-specific caution.** FC/IS says where decisions and effects go; it does **not** identify aggregate owners, module interfaces, or cross-slice sequencing. A shell can still become a large procedural junk drawer while remaining perfectly imperative. Conversely, “all logic belongs in core” would be too broad: transaction control, authorization, retries, durable continuation, and external-outcome classification are effectful application responsibilities even when they must not contain aggregate rules.

## 2. DDD Modules: organize concepts, not roles

### Sourced guidance

Evans treats a Module as part of the model rather than merely a technical package. Modules should “tell the story of the system,” contain cohesive concepts, use names from the Ubiquitous Language, and permit their concepts to be reasoned about independently ([DDD Reference](https://www.domainlanguage.com/wp-content/uploads/2016/05/DDD_Reference_2015-03.pdf), p. 15). His **Conceptual Contours** pattern warns against both an undifferentiated monolith and over-fragmentation that forces callers to reassemble tiny pieces; decomposition should follow cohesive domain divisions and observed axes of change ([same source](https://www.domainlanguage.com/wp-content/uploads/2016/05/DDD_Reference_2015-03.pdf), p. 27).

Evans separately names **Cohesive Mechanism** for a conceptually cohesive algorithm whose “how” would otherwise swamp the domain's “what.” It should expose an intention-revealing interface and hide the mechanism's intricacy ([same source](https://www.domainlanguage.com/wp-content/uploads/2016/05/DDD_Reference_2015-03.pdf), p. 44). This is not a license for a generic utilities package: the trigger is one coherent mechanism with enough complexity to hide.

Robert Martin's original **Screaming Architecture** essay makes a parallel structural argument: the top-level source shape should reveal the application's use cases and domain, not its frameworks, and framework/web details should remain peripheral ([Martin, “Screaming Architecture,” 2011](https://blog.cleancoder.com/uncle-bob/2011/09/30/Screaming-Architecture.html)).

### Applicability to Fidy

**Application-specific conclusion.** These sources support names such as `transactions`, `subscription`, `browser-login`, or a specific process/mechanism name. They argue against `services`, `managers`, `helpers`, `common`, or an unqualified `application` as grouping principles. A named cohesive shell module is justified by hidden sequencing, lifecycle, policy, or algorithmic complexity—not by file count and not merely because several callers share code.

**Application-specific caution.** A DDD Module does not have to equal one aggregate, one API group, one folder, or one deployment unit. Fidy's “slice owns data” rule remains the sharper ownership test. Some owner modules can encompass more than one closely bound concept; some ownerless mechanisms can deserve a module; and a cross-slice process can be a module while owning no aggregate data. Forcing all directories to identical granularity would conflict with Evans' conceptual-contour guidance.

## 3. Aggregates and owner-published operations

### Sourced guidance

Evans defines an Aggregate as a cluster of entities and value objects with one root and a boundary around its invariants. External references point to the root; aggregate properties and invariants are enforced at the boundary. He uses aggregate boundaries to govern transactions and says consistency rules are synchronous within a boundary and asynchronous across boundaries ([DDD Reference](https://www.domainlanguage.com/wp-content/uploads/2016/05/DDD_Reference_2015-03.pdf), p. 16). His Repository pattern warns that unconstrained queries into aggregate internals breach encapsulation and push domain logic into queries and application code; repositories are for aggregate roots that need direct access ([same source](https://www.domainlanguage.com/wp-content/uploads/2016/05/DDD_Reference_2015-03.pdf), p. 17).

Vaughn Vernon's original aggregate-design essay sharpens the same heuristic: an Aggregate is a transactional consistency boundary, should protect true business invariants, and should be kept small rather than absorbing every related object ([Vernon, “Effective Aggregate Design, Part I”](https://www.dddcommunity.org/wp-content/uploads/files/pdf_articles/Vernon_2011_1.pdf), pp. 3–6).

### Applicability to Fidy

**Application-specific conclusion.** “Owner-published operation” is a functional translation of aggregate encapsulation. Callers need a capability in domain language that preserves invariants; they should not receive repository primitives, tables, mutable internals, or enough state to recreate the owner's decision. In Fidy, this operation can be a plain Effect-returning function. It need not be an OO aggregate-root method or a `Context.Service`.

The aggregate rule also distinguishes two often-confused interfaces:

- A narrow `reference.ts` can publish identity/value vocabulary needed to refer to an owner.
- A shell owner operation publishes behavior needed to observe or transition that owner's data.

Neither publication makes the owner's model, rules, or repository generally shared.

**Application-specific caution.** “One aggregate per transaction” and asynchronous cross-aggregate updates are modeling heuristics, not permission to alter Fidy's accepted transaction-composable mutations or existing coordination decisions. The map explicitly preserves behavior and atomicity. The later design must represent accepted compositions as owner-operation composition, not silently redraw aggregates to match a folder scheme.

## 4. Service Layer and application-process coordination

### Sourced guidance

Martin Fowler's original **Service Layer** catalog entry defines an application's boundary as a set of available operations and says the layer coordinates the application's response, controls transactions, and avoids duplicating the same interaction logic across multiple client interfaces ([Fowler, “Service Layer”](https://martinfowler.com/eaaCatalog/serviceLayer.html)). Evans' Layered Architecture pattern distinguishes domain logic from application-task management and asks that the domain remain free of application and infrastructure responsibilities ([DDD Reference](https://www.domainlanguage.com/wp-content/uploads/2016/05/DDD_Reference_2015-03.pdf), p. 10).

These sources use “service” in older OO architectural senses. They do not imply Effect `Context.Service`, a `services/` directory, one class per use case, or one wrapper per repository call.

### Applicability to Fidy

**Application-specific conclusion.** The useful part for Fidy is the role, not the noun: an application-process module can sequence owner-published operations, delimit a transaction where an accepted decision permits it, map the result into a canonical operation, and make the same behavior reusable from HTTP, hosted-agent, and batch execution. This aligns with the current graph rule that handlers and canonical registries delegate to queries, mutations, or named coordination modules rather than importing another handler or repository (`apps/server/.dependency-cruiser.mjs:141-165`).

**Application-specific caution.** A global `application/`, `use-cases/`, or `services/` layer would be another role bucket. It would also risk shallow pass-through modules whose interface is as complex as their implementation. Coordination should be named for the process it performs and should exist only when it centralizes sequencing used by a stable caller seam or hides meaningful complexity. Immediate business decisions still belong to the owner/core; adapters still own transport translation.

## 5. Process Manager: only for stateful, dynamic processes

### Sourced guidance

Hohpe and Woolf's original **Process Manager** pattern addresses a sequence whose later steps depend on intermediate results or may branch/run in parallel. A central manager maintains sequence state and chooses the next processing step. The authors explicitly caution that the central hub can become a bottleneck and that using a Process Manager for every integration problem is overkill and can distract from the actual design issue ([Enterprise Integration Patterns, “Process Manager”](https://www.enterpriseintegrationpatterns.com/patterns/messaging/ProcessManager.html)).

### Applicability to Fidy

**Application-specific conclusion.** This name fits durable, stateful, multi-step coordination that must remember progress and react to outcomes. It does not fit an ordinary synchronous function that loads two owner projections, invokes a pure decision, and commits an accepted composition. “Process” is Fidy's broader ownership category; “Process Manager” should remain the narrower established pattern.

**Application-specific caution.** Central coordination naturally attracts domain decisions and owner state. A Fidy Process Manager, if one is identified later, should retain only process state and sequencing rules and invoke owner-published operations. It must not become a universal event bus, a repository bypass, or a central model of all participating aggregates.

## 6. Shared Kernel, shared values, and the junk-drawer risk

### Sourced guidance

In Evans' strategic DDD, **Shared Kernel** is specifically a relationship between separate bounded contexts/teams. The teams designate an explicit subset of model and associated code/database design, keep it small, consult on changes, and continuously integrate it ([DDD Reference](https://www.domainlanguage.com/wp-content/uploads/2016/05/DDD_Reference_2015-03.pdf), p. 31). This intimacy is the reason for the caution, not a recommendation to collect widely useful helpers.

Evans' **Generic Subdomain** is different: it is a cohesive supporting model that does not express the product's differentiating knowledge. It should be factored into its own module and contain no trace of the core specialty ([same source](https://www.domainlanguage.com/wp-content/uploads/2016/05/DDD_Reference_2015-03.pdf), p. 41). A Generic Subdomain is therefore also not a miscellaneous `shared/` folder.

Fidy is explicitly one bounded context (`apps/server/ARCHITECTURE.md:47-49`). Its current graph allows cross-core use only through ownerless `_shared` values or the owning slice's `reference.ts`, and rejects sibling implementation imports (`apps/server/.dependency-cruiser.mjs:56-68`).

### Applicability to Fidy

**Application-specific conclusion.** Fidy's `_shared` is at most analogous to a small kernel; it is not Evans' cross-bounded-context Shared Kernel. The more precise tests for admitting a source module are:

1. **Owner test:** if one aggregate or process gives the concept meaning or lifecycle, it stays with that owner and is published narrowly from there.
2. **Semantic test:** the concept has one stable meaning across all callers, not merely a similar TypeScript shape.
3. **Behavior test:** owner decisions do not move into shared code; shared code is an ownerless value/policy or one cohesive mechanism.
4. **Interface test:** callers import an intentional declaration/operation, not an implementation barrel.
5. **Change test:** the likely changes are genuinely common. If a change for one caller would add options or branches irrelevant to another, sharing is hiding divergence.

These are design-review tests, not claims from Evans. They operationalize his “small explicit subset” warning inside Fidy's one-context constraints.

**Application-specific caution.** Replacing `_shared` with several role-named drawers merely distributes the problem. Import count is evidence of reuse, not evidence of shared ownership. Conversely, deleting all shared code can duplicate security-critical policy and canonical derivation. The relevant distinction is ownerless/cohesive versus owner-owned, not shared versus duplicated in the abstract.

## 7. Modular monolith and source-tree organization

### Sourced guidance

Simon Brown defines the important axes separately: modularity is not the same as the number of deployment units. In his original package-organization comparison:

- package-by-layer creates technical buckets and weakly communicates the domain;
- package-by-feature improves domain visibility but can still expose everything or provide only a controller as its public entry;
- package-by-component groups related business logic and persistence behind a well-defined interface while keeping implementation details hidden;
- organization without access control is not encapsulation, and a common infrastructure ring can let one adapter call another adapter or repository around the domain ([Brown, “Modular monolith and package by component”](https://simonbrown.je/modular-monolith/)).

Brown also cautions that splitting every component into a separate source tree can bring build-time, complexity, and maintenance costs. His Java access-modifier mechanism is language-specific; the architectural point is a small published interface plus hidden implementation.

Shopify's first-party account defines its modular monolith as one application with strictly enforced boundaries between domains. It reorganized a Rails layer-major tree around real-world concepts, then separately worked on public interfaces, exclusive data ownership, dependency tracking, and boundary violations. Shopify says the file move alone did not isolate dependencies and that full isolation remained ongoing ([Shopify Engineering, “Deconstructing the Monolith”](https://shopify.engineering/deconstructing-monolith-designing-software-maximizes-developer-productivity)).

### Applicability to Fidy

The following are **comparison candidates**, not proposals:

| Established organization idea                   | What it could illuminate for Fidy                                                         | Conflict/caution under fixed constraints                                                                                                                                                                    |
| ----------------------------------------------- | ----------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Pure package-by-layer                           | Keeps the purity axis obvious.                                                            | Generic technical layers do not expose domain ownership and can grow into large buckets. Fidy already rejects expanding this beyond the meaningful `core/`/`shell/` split.                                  |
| Pure package-by-feature                         | Colocates one domain area's core, persistence, operations, and adapters.                  | A feature-major top level would remove the mandated `core/`/`shell/` compiler-visible fence and make purity depend on nested naming or tooling. It is out of bounds as the top-level answer.                |
| Package-by-component                            | Emphasizes one small published owner interface and hidden implementation.                 | Brown's example deliberately groups domain and persistence; Fidy must retain their physical separation and plain-function/repository conventions. The encapsulation idea transfers, not the literal layout. |
| Feature packages **inside fixed layers**        | Retains `core/<owner>` and `shell/<owner>` while making both trees speak domain language. | One conceptual module is physically split across two trees; locality is weaker, and “same folder name” must not imply shell access to core internals or cross-owner access.                                 |
| Separate TypeScript projects/packages per owner | Gives compiler/package-level publication and explicit project dependencies.               | Adds manifests, build outputs, references, and potentially awkward cross-cutting `core/`/`shell/` structure. It can be disproportionate for in-process owners and is not required for a modular monolith.   |

**Application-specific conclusion.** Brown and Shopify provide evaluation criteria rather than a ready-made target: can a reader find the owner, can a caller see one intentional interface, can implementation and data be bypassed, and does enforcement survive a file move? Because Fidy retains a layer-major top level, later designs should compare ways to recover feature locality _within_ that fixed axis rather than rehearse layer-major versus feature-major as an unconstrained choice.

## 8. Composition Root

### Sourced guidance

Mark Seemann's original summary defines a **Composition Root** as the preferably unique place where modules are composed, as close as possible to the application's entrypoint. Only applications have one; libraries do not. If a DI container is used, it should be referenced only there ([Seemann, “Composition Root,” 2011](https://blog.ploeh.dk/2011/07/28/CompositionRoot/)).

Effect's exact implementation gives Fidy a functional object/resource graph rather than an OO constructor graph. `Layer.provide` supplies and hides requirements, and Layer memoization is based on Layer identity (`.patterns/layers-runtime.md:83-100`). `Layer.launch` builds the Layer in a Scope and waits until interruption, allowing scoped finalization (`.patterns/layers-runtime.md:151-162`). Fidy already embodies this in `src/main.ts` (`apps/server/src/main.ts:1-22`).

### Applicability to Fidy

**Application-specific conclusion.** The Composition Root lens can separate three landmarks that should not be conflated:

- `shell/api.ts`: declaration assembly for canonical operations;
- shell process/owner modules: executable application behavior and coordination;
- `main.ts` (possibly through one shell assembly): selection and provision of production Layers, then launch.

The root may be verbose because it reveals the production graph; that is different from containing behavior. Provider configuration, lifecycle acquisition, and concrete Layer selection belong there or in production Layer constructors reached from there. Domain decisions, operation sequencing, and adapter response mapping do not.

**Application-specific caution.** Moving every `Layer.mergeAll` expression into a directory called `composition/` can create another bucket without improving the graph. The question is whether assembly is hierarchical and named by the capability it constructs, while one final root selects production implementations. Also, Seemann's requirement to inject all dependencies should not override Fidy's deliberate rule that plain functions and existing Effect services are preferred over speculative seams.

## 9. Enforceable module boundaries

### Sourced guidance

Three enforcement strengths are relevant:

1. **Import-graph policy.** dependency-cruiser parses JavaScript/TypeScript dependencies, validates them against project-defined rules, and can fail a build for `error` severity violations ([dependency-cruiser README](https://github.com/sverweij/dependency-cruiser); [rules reference](https://github.com/sverweij/dependency-cruiser/blob/main/doc/rules-reference.md)). Its rules can use captured path groups to reject imports between peer business folders without enumerating every folder. With `tsPreCompilationDeps`, type-only imports remain graph edges ([options reference](https://github.com/sverweij/dependency-cruiser/blob/main/doc/options-reference.md#tsprecompilationdeps)). The project documents an important static-analysis limit: variable/expression-based imports cannot be resolved, and its analysis is module-level rather than function/class-level ([dependency-cruiser FAQ](https://github.com/sverweij/dependency-cruiser/blob/main/doc/faq.md#q-does-dependency-cruiser-handle-variable-or-expression-requires-and-imports)).
2. **Build-project boundaries.** TypeScript project references split a program into projects, make consumers read referenced declaration output, and let `tsc --build` order dependencies. They improve logical grouping but require `composite`, declarations, more configuration, and built/in-memory declaration handling ([TypeScript Handbook, “Project References”](https://www.typescriptlang.org/docs/handbook/project-references)).
3. **Published package entrypoints.** Node's `exports` field prevents package consumers from using unlisted subpaths and thereby defines a public package interface, but Node explicitly says this is not strong encapsulation against absolute-path loading ([Node.js, “Package entry points”](https://nodejs.org/api/packages.html#package-entry-points)). This mechanism acts at package boundaries, not between arbitrary folders inside one package.

Spring Modulith is useful as a language-independent reference model even though it is not a TypeScript option. It models a module as a provided interface, internal implementation, and required interfaces; its verifier rejects module cycles, access to internals, and optionally undeclared module dependencies ([Spring Modulith, “Application Modules”](https://docs.spring.io/spring-modulith/reference/fundamentals.html); [“Verifying Application Module Structure”](https://docs.spring.io/spring-modulith/reference/verification.html)). Its named interfaces show that a module can deliberately publish more than one cohesive seam without publishing all internals.

### Applicability to Fidy

Fidy already has a strong base: dependency-cruiser rejects core-to-shell access, sibling-core implementation access, handler-to-repository bypasses, cycles, barrels, and imports outside `shell/api.ts`'s assembly role (`apps/server/.dependency-cruiser.mjs:56-88,141-165,220-227`). Probe files include type-only forbidden edges (`apps/server/scripts/check-dependency-guards.ts:112-127`) and assert that allowed probes pass while forbidden probes both fail and produce the intended diagnostics (`apps/server/scripts/check-dependency-guards.ts:551-578`).

**Application-specific conclusion.** Later designs can compare enforcement in increasing cost order:

- path-based graph rules over the existing package;
- explicit owner entry modules plus graph rules denying internal imports;
- generated/validated owner dependency declarations;
- separate TypeScript projects or workspace packages with narrow exports.

The least expensive mechanism that makes the chosen interface non-bypassable is enough. A design should not split workspace packages merely to imitate Java package-private visibility, but it should not call a folder a module if every file remains importable from everywhere.

**Application-specific caution.** Static import rules cannot prove data ownership, runtime authorization, semantic purity, or that a coordinator contains only sequencing. They can also silently miss a graph if resolver/compiler integration is broken—an issue Fidy already counters with its probe harness. Every new architectural rule therefore needs both an understandable diagnostic and positive/negative probes. Review-only checks remain necessary for ownership and depth.

## 10. Comparative fit against the map constraints

Legend: **direct** = the pattern directly addresses the concern; **supporting** = useful but incomplete; **risk** = easy to misapply.

| Pattern/guidance                      | Purity               | Aggregate ownership   | Explicit coordination                | Narrow sharing                 | Composition | Enforceability                      | Principal Fidy caution                                                                 |
| ------------------------------------- | -------------------- | --------------------- | ------------------------------------ | ------------------------------ | ----------- | ----------------------------------- | -------------------------------------------------------------------------------------- |
| Functional Core / Imperative Shell    | **direct**           | silent                | supporting                           | silent                         | supporting  | supporting                          | A pure core does not prevent an unstructured shell.                                    |
| DDD Modules                           | supporting           | supporting            | supporting                           | supporting                     | silent      | silent                              | Do not equate module with folder, API group, or uniform granularity.                   |
| DDD Aggregates                        | supporting           | **direct**            | constrains                           | constrains                     | silent      | review/data tests                   | Literal OO aggregate shapes and blanket async rules do not transfer automatically.     |
| Service Layer                         | supporting           | constrains            | **direct**                           | supporting                     | supporting  | supporting                          | `services/` can become a pass-through role bucket; “service” is not `Context.Service`. |
| Process Manager                       | silent               | constrains            | **direct for stateful dynamic work** | silent                         | supporting  | runtime tests                       | Overkill for ordinary sequencing; central hub can absorb behavior and state.           |
| Shared Kernel                         | silent               | constrains            | silent                               | **direct between contexts**    | silent      | governance + graph                  | Fidy has one bounded context; `_shared` is not literally this pattern.                 |
| Cohesive Mechanism                    | supporting           | supporting            | supporting                           | alternative to generic sharing | silent      | interface tests                     | Extraction must hide one coherent complexity, not collect helpers.                     |
| Modular monolith/package-by-component | supporting           | **direct**            | supporting                           | supporting                     | supporting  | **direct if interfaces are closed** | Literal feature-major/package-private recipes conflict with fixed TypeScript layout.   |
| Composition Root                      | supports             | silent                | separates                            | silent                         | **direct**  | graph/startup tests                 | Root selects implementations; it must not become application behavior.                 |
| Graph/project/package enforcement     | enforces stated rule | enforces imports only | enforces call direction only         | **direct for imports**         | supports    | **direct**                          | Tools cannot infer semantic ownership or module depth.                                 |

## 11. Questions for later Design It Twice work

These are deliberately unresolved by this research:

1. **Owner interface shape:** Is one owner's shell interface best represented by named `queries.ts`/`mutations.ts`, one owner operation module, several named interfaces, or another small seam? How much interface can be hidden without obscuring canonical-operation derivation?
2. **Physical locality inside fixed layers:** Should `core/<owner>` and `shell/<owner>` remain parallel directories, gain explicitly named submodules, or use another nested arrangement that keeps the purity fence visible?
3. **Coordinator placement and naming:** What structural test distinguishes an owner-local process, a cross-owner synchronous coordinator, and a durable Process Manager? Where should each live without creating `processes/` as a catch-all?
4. **Publication rule:** What exact files may another owner import—`reference.ts`, a shell operations seam, event schemas, or named interfaces—and should the allowed dependency graph be deny-by-default?
5. **Shared-code admission:** Which existing `_shared` modules are truly ownerless values/policies, which are cohesive mechanisms deserving names, and which belong to an owner? This requires a separate inventory; this report did not classify files.
6. **Composition depth:** Should `http.ts` remain the single large application Layer assembly, or should named subsystem Layers hide portions while `main.ts` remains the unique production root? The answer should be compared by interface depth and startup/shutdown observability, not line count.
7. **Enforcement granularity:** Can dependency-cruiser path rules and probes make owner interfaces non-bypassable, or would selected owners benefit enough from TypeScript project/package boundaries to justify their overhead?
8. **Accepted atomic compositions:** Which existing cross-slice transactions are explicit exceptions that the new source shape must make visible? Their inventory is necessary before a deny-by-default owner graph can be complete.
9. **Read models:** Which cross-owner queries are projections owned by a named process/read model rather than aggregate behavior, and how can they avoid becoming a sanctioned route to owner tables?
10. **Migration sequence:** Can the architecture be introduced by moves and rules with behavior held constant, and can each stage add enforcement before the next move? Shopify's experience makes file organization and isolation separate work.

## Source assessment

Material claims above rely on original author texts, official project documentation, first-party implementation experience, or repository sources:

- Bernhardt for Functional Core / Imperative Shell and value boundaries.
- Evans' official DDD Reference for layers, Modules, Aggregates, Shared Kernel, Generic Subdomains, Conceptual Contours, and Cohesive Mechanisms.
- Vernon for aggregate-design refinements.
- Fowler for Service Layer.
- Hohpe/Woolf for Process Manager.
- Brown for modular monolith/package organization and encapsulation.
- Shopify Engineering for Shopify's own modularization experience.
- Seemann for Composition Root.
- Cockburn for Hexagonal Architecture.
- Official dependency-cruiser, TypeScript, Node.js, and Spring Modulith documentation for enforcement capabilities and limits.

The report labels transfers and cautions specific to Fidy as **application-specific conclusions**. No secondary source is used as evidence for a material finding.
