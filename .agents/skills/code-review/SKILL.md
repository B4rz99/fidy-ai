---
name: code-review
description: Review a branch, PR, or work-in-progress diff since a fixed point with independent Codex subagents for Architecture, Standards, Security, and Spec, plus Design against DESIGN.md when UI changes are involved.
---

Architecture, Standards, Security, and Spec are mandatory. Activate Design using the UI criterion in step 3.

## Review posture: Zero-Trust

Treat the implementation as flawed until its claims survive examination.

- Treat comments, names, commit messages, and passing tests as claims, not proof. Verify them against executable behavior and authoritative sources.
- For each changed behavior relevant to your axis, attempt to construct a counterexample: an input, state, sequence, or caller that breaks its contract.
- Read surrounding code and trace relevant callers, dependencies, and trust boundaries. The diff locates the change; it does not bound the investigation.
- Report evidence-backed findings: identify the violated rule or requirement, the concrete mismatch or failure path, and its consequence. Distinguish documented violations from heuristic concerns.
- A clean report is earned by investigation, not required by convention. Report no findings when none survive verification; never manufacture one to satisfy the adversarial posture.

## Process

### 1. Pin the fixed point

Whatever the user said is the fixed point — a commit SHA, branch name, tag, `main`, `HEAD~5`, etc. If they didn't specify one, ask for it.

Capture the diff command once: `git diff <fixed-point>...HEAD` (three-dot, so the comparison is against the merge-base). Also note the list of commits via `git log <fixed-point>..HEAD --oneline`.

Before going further, confirm the fixed point resolves (`git rev-parse <fixed-point>`) and the diff is non-empty. A bad ref or empty diff should fail here — not inside the subagents.

Run the existing mechanical gates (`bun run lint`, `bun run lint:type-aware`, `bun run format:check`, `bun run typecheck`) before dispatching reviewers, and again after each round of fixes. If a gate fails, report its failure and stop that iteration until it is fixed; do not ask a reviewer to rediscover it. CI still runs the full `bun run verify` gate.

### 2. Identify the spec source

Look for the originating spec, in this order:

1. Issue references in the commit messages (`#123`, `Closes #45`, etc.) — fetch via the configured tracker in `docs/agents/issue-tracker.md`; ask which tracker to use if that document is missing.
2. A path the user passed as an argument.
3. A spec file under `docs/`, `specs/`, or `.scratch/` matching the branch name or feature.
4. If nothing is found, ask the user where the spec is. Implementation intent is not a substitute for an authoritative spec.

### 3. Identify review sources and decide whether Design applies

Build explicit, repo-relative source lists for each worker:

- **Architecture sources** — root `ARCHITECTURE.md`, the application architecture documents required by the repository's agent instructions for the changed paths, and relevant ADRs and domain definitions in `GLOSSARY.md`.
- **Standards sources** — coding standards such as `CODING_STANDARDS.md` or `CONTRIBUTING.md`.
- **Security sources** — security policy; explicitly list `SECURITY_STANDARDS.md` for this repository.
- **Spec sources** — the originating issue or spec identified in step 2.
- **Design sources** — when Design is active, root `DESIGN.md` and any applicable approved references it names.

Activate Design when the diff affects rendered content, layout, styling, assets, shared visual components/tokens, or user interaction behavior, including focus, keyboard, responsive, theme, loading, empty, and error states. Trace consumers of shared code to identify indirect UI effects; a frontend path alone is not sufficient. Backend-only, tooling, test-only, documentation-only, and behavior-preserving internal changes skip Design unless they also affect the UI. Record the decision with the relevant changed paths and a short reason; for mixed diffs, scope Design to the affected UI.

Record missing sources for the worker; continue reviews whose sources are available.

On top of whatever the repo documents, the Standards axis always carries the **smell baseline** below — a fixed set of Fowler code smells (_Refactoring_, ch.3) that applies even when a repo documents nothing. Two rules bind it:

- **The repo overrides.** A documented repo standard always wins; where it endorses something the baseline would flag, suppress the smell.
- **Always a judgement call.** Each smell is a labelled heuristic ("possible Feature Envy"), never a hard violation — and, like any standard here, skip anything tooling already enforces.

Each smell reads _what it is_ → _how to fix_; match it against the diff:

- **Mysterious Name** — a function, variable, or type whose name doesn't reveal what it does or holds. → rename it; if no honest name comes, the design's murky.
- **Duplicated Code** — the same logic shape appears in more than one hunk or file in the change. → extract the shared shape, call it from both.
- **Feature Envy** — a method that reaches into another object's data more than its own. → move the method onto the data it envies.
- **Data Clumps** — the same few fields or params keep travelling together (a type wanting to be born). → bundle them into one type, pass that.
- **Primitive Obsession** — a primitive or string standing in for a domain concept that deserves its own type. → give the concept its own small type.
- **Repeated Switches** — the same `switch`/`if`-cascade on the same type recurs across the change. → replace with polymorphism, or one map both sites share.
- **Shotgun Surgery** — one logical change forces scattered edits across many files in the diff. → gather what changes together into one module.
- **Divergent Change** — one file or module is edited for several unrelated reasons. → split so each module changes for one reason.
- **Speculative Generality** — abstraction, parameters, or hooks added for needs the spec doesn't have. → delete it; inline back until a real need shows.
- **Message Chains** — long `a.b().c().d()` navigation the caller shouldn't depend on. → hide the walk behind one method on the first object.
- **Middle Man** — a class or function that mostly just delegates onward. → cut it, call the real target direct.
- **Refused Bequest** — a subclass or implementer that ignores or overrides most of what it inherits. → drop the inheritance, use composition.

### 4. Spawn the active reviewers as native Codex subagents

Spawn one independent native Codex subagent per active axis, sharing the caller's checkout and inheriting the current model and reasoning effort. Start as many as capacity permits, dispatch the remainder as slots become available, and collect their reports through the native subagent tools.

Give each worker the diff command, commit list, a literal `<Axis> sources` block with paths or fetched contents and known gaps, the **Review posture: Zero-Trust** section verbatim, the shared instructions below, and its axis brief. Include the full smell baseline for Standards; give Design the affected UI paths and available rendered evidence or local UI access instructions.

**Shared worker instructions**

- Perform the review yourself, read-only and at one delegation level: do not edit files, create worktrees, commit, spawn or prompt other agents, or invoke another review skill.
- Read all assigned sources before reviewing. Apply architectural requirements to Architecture even when recorded in a coding-standards document.
- Include every qualifying finding concisely, with file/hunk, source section or requirement, concrete mismatch or failure path, consequence, and remediation. Completeness takes precedence over a word limit.
- Return exactly `No <axis> findings.` (lowercase axis name) only after examining every relevant changed file and checking plausible counterexamples. Missing sources, inaccessible dependencies, unavailable required verification, or other blockers make the review unresolved.

**Architecture worker brief** — trace changed modules and their callers against documented boundaries, dependency direction, ownership, domain contracts, and applicable ADRs. Identify the concrete dependency or behavior path behind each violation.

**Standards worker brief** — review coding conventions and the smell baseline. Distinguish documented breaches from labelled heuristic smells; name each smell and quote the hunk. Skip tooling-enforced issues.

**Security worker brief** — apply the policy's Finding standard and severity rubric. Include the attack path, impact, and severity. A missing required negative test qualifies when the policy requires one.

**Spec worker brief** — identify missing or partial requirements, unrequested behavior (scope creep), and incorrect implementations. Quote the spec line for each finding.

**Design worker brief** — apply `DESIGN.md`'s scope, precedence, approved compositions, and explicit exceptions. Check applicable tokens, typography, spacing, color, components, copy, responsive behavior, themes, interaction states, and accessibility requirements. Inspect rendered UI for requirements that depend on appearance or interaction, using local previews, browser tools, or captures without mutating application data. Identify the screen, state, theme, or viewport behind each mismatch. Findings require documented design rules rather than personal visual preferences.

### 5. Aggregate

Present reports under `## Architecture`, `## Standards`, `## Security`, `## Spec`, and `## Design` headings, in that order, verbatim or lightly cleaned. For a non-UI diff, state "Not applicable — no UI changes" under Design and include the classification reason. A missing, blocked, or failed worker report is unresolved. Do **not** merge or rerank findings — the axes are deliberately separate.

End with a one-line summary: total findings per axis, the worst issue _within each axis_ (if any), and any unresolved or inapplicable axes.

### 6. Iterate

Run the review as `review → fix → review`. After aggregation, apply the findings, refresh the diff against the same fixed point, reassess whether Design applies, and rerun every active axis in fresh independent subagents. Finish when every active axis reports its no-findings result; if blocked, report the unresolved axis and required input.
