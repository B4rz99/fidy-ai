---
name: code-review
description: Review a branch, PR, or work-in-progress diff since a fixed point with independent Codex subagents for Architecture, Standards, Security, and Spec, plus Design against DESIGN.md when UI changes are involved.
---

Review the diff between `HEAD` and a fixed point the user supplies along four mandatory axes and one conditional axis:

- **Architecture** — does the code preserve the documented system shape, module ownership, and application boundaries?
- **Standards** — does the code conform to this repo's documented coding standards and the smell baseline?
- **Security** — does the code satisfy this repo's documented security policy?
- **Spec** — does the code faithfully implement the originating issue / spec?
- **Design** — when UI changes are involved, does the affected experience follow `DESIGN.md`?

Architecture, Standards, Security, and Spec are always required. Design is active only for UI changes, as determined in step 3.

Each active axis runs as an **independent native Codex subagent** so the reviews don't pollute each other's context, then this skill aggregates their findings. The workers are read-only and share the caller's checkout.

The issue tracker should have been provided to you — read `docs/agents/issue-tracker.md` for the configured tracker. If it is missing, ask which tracker to use.

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

1. Issue references in the commit messages (`#123`, `Closes #45`, GitLab `!67`, etc.) — fetch via the workflow in `docs/agents/issue-tracker.md`.
2. A path the user passed as an argument.
3. A spec file under `docs/`, `specs/`, or `.scratch/` matching the branch name or feature.
4. If nothing is found, ask the user where the spec is. If no spec is available, keep **Spec** required and report it as unresolved; do not substitute implementation intent for an authoritative spec.

### 3. Identify review sources and decide whether Design applies

Build explicit, repo-relative source lists for each worker:

- **Architecture sources** — root `ARCHITECTURE.md`, the application architecture documents required by the repository's agent instructions for the changed paths, and relevant ADRs and domain definitions in `GLOSSARY.md`.
- **Standards sources** — coding standards such as `CODING_STANDARDS.md` or `CONTRIBUTING.md`. Architectural requirements belong to Architecture even when recorded in a shared document.
- **Security sources** — security policy; explicitly list `SECURITY_STANDARDS.md` for this repository.
- **Spec sources** — the originating issue or spec identified in step 2.
- **Design sources** — when Design is active, root `DESIGN.md` and any applicable approved references it names.

Activate Design when the diff affects rendered content, layout, styling, assets, shared visual components/tokens, or user interaction behavior, including focus, keyboard, responsive, theme, loading, empty, and error states. Trace consumers of shared code to identify indirect UI effects; a frontend path alone is not sufficient. Backend-only, tooling, test-only, documentation-only, and behavior-preserving internal changes skip Design unless they also affect the UI. Record the decision with the relevant changed paths and a short reason; for mixed diffs, scope Design to the affected UI.

Missing required sources leave their axis unresolved. Missing `DESIGN.md` for a UI change leaves Design unresolved rather than inapplicable. Resolve source gaps with the user without inventing requirements; continue reviews whose sources are available.

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

Spawn one independent, read-only Codex subagent per active axis using the native subagent tools: four for non-UI changes, five for UI changes. They share the caller's checkout and inherit the current model and reasoning effort. If concurrency limits prevent starting them all together, run the remaining reviewers as slots become available; keep a separate subagent and report for every active axis.

Give each subagent a self-contained task with the full diff command, commit list, its axis brief below, and a literal `<Axis> sources` block naming its source paths or fetched contents. Include known source gaps so the worker can report them as unresolved. Include the smell baseline in full in the Standards task. Give Design the affected UI paths and available rendered evidence or instructions for accessing the local UI.

Include the **Review posture: Zero-Trust** section verbatim in every worker's task. Each worker applies it within its assigned axis.

Tell each subagent to perform its assigned review itself, at one delegation level only. Keep it read-only: do not edit files, create worktrees, commit, spawn or prompt other agents, or invoke another review skill.

Start as many active reviewers as capacity allows before waiting for results, then dispatch the rest as slots become available. Collect their completed reports through the native subagent tools. A missing, blocked, or failed report remains unresolved; it does not count as a passing axis.

**Architecture worker brief** — first read every path in `Architecture sources`. Trace changed modules and their callers against documented boundaries, dependency direction, ownership, domain contracts, and applicable ADRs. Report each violation with its file/hunk, source section, concrete dependency or behavior path, consequence, and remediation. Keep coding conventions and baseline smells in Standards. Report exactly "No architecture findings." when none qualify. Include every qualifying finding; completeness takes precedence over a word limit.

**Standards worker brief** — first read every path in the prompt's `Standards sources` block. Review documented coding standards and the smell baseline only; architectural conformance belongs to Architecture. Report per file/hunk where relevant (a) every place the diff violates a documented standard, citing the source file and rule; and (b) any baseline smell, naming it and quoting the hunk. Distinguish hard documented-standard breaches from judgement calls. A documented repo standard overrides the baseline. Skip tooling-enforced issues. Report exactly "No standards findings." when none qualify. Keep findings concise. Include every qualifying finding; completeness takes precedence over a word limit.

**Security worker brief** — first read every path in the prompt's `Security sources` block. Apply the policy's Finding standard and severity rubric. Report each qualifying finding with its file/hunk, policy section, attack path, impact, remediation, and severity. A missing required negative test qualifies when the policy requires one. Report exactly "No security findings." when none qualify. Keep findings concise. Include every qualifying finding; completeness takes precedence over a word limit.

**Spec worker brief** — first read every source in `Spec sources`. If no authoritative spec is available, report Spec as unresolved. Otherwise report (a) requirements the spec asked for that are missing or partial; (b) behaviour in the diff that was not asked for (scope creep); and (c) requirements that look implemented but where the implementation looks wrong. Quote the spec line for each finding. Report exactly "No spec findings." when none qualify. Keep findings concise. Include every qualifying finding; completeness takes precedence over a word limit.

**Design worker brief** — first read every path in `Design sources`, starting with `DESIGN.md`. Apply its scope, precedence, approved screen compositions, and explicit exceptions. Review the affected UI against applicable tokens, typography, spacing, color, components, copy, responsive behavior, themes, interaction states, and accessibility requirements. Inspect the implementation and the rendered UI for requirements that depend on appearance or interaction, using available local previews, browser tools, or captures without mutating application data. Report each violation with its file/hunk, design section, observed mismatch, user impact, and remediation; identify the screen, state, theme, or viewport when relevant. Documented design rules govern findings; personal visual preferences do not. Report unavailable visual or interaction verification as unresolved. Report exactly "No design findings." only when the applicable checks are complete and none qualify. Include every qualifying finding; completeness takes precedence over a word limit.

Before returning a no-findings result, verify that every changed file relevant to your axis was examined and that plausible counterexamples were checked against the implementation. If missing sources, inaccessible dependencies, or other blockers prevent that examination, report the limitation as unresolved instead of returning the no-findings result. Include this completion criterion in every worker's task.

### 5. Aggregate

Present reports under `## Architecture`, `## Standards`, `## Security`, `## Spec`, and `## Design` headings, in that order, verbatim or lightly cleaned. For a non-UI diff, state "Not applicable — no UI changes" under Design and include the classification reason. Report source gaps and incomplete reviews as unresolved under their axis. Do **not** merge or rerank findings — the axes are deliberately separate.

End with a one-line summary: total findings per axis, the worst issue _within each axis_ (if any), and any unresolved or inapplicable axes. Don't pick a single winner across axes — that's the reranking the separation exists to prevent.

### 6. Iterate

Run the review as `review → fix → review`. After aggregation, apply the findings, refresh the diff against the same fixed point, reassess whether Design applies, and rerun every active axis in fresh independent subagents. Finish successfully only when all four mandatory axes and Design, when applicable, report their no-findings result. If a blocker prevents completion, report the unresolved axis and required input rather than claiming a clean review.

## Why separate axes

A change can pass one axis and fail another:

- Code that follows coding conventions but crosses an application boundary → **Standards pass, Architecture fail.**
- Code that matches the feature spec but violates an approved screen composition → **Spec pass, Design fail.**
- Code that follows coding standards but has an authorization flaw → **Standards pass, Security fail.**
- Code that is secure but implements the wrong thing → **Security pass, Spec fail.**
- Code that does exactly what the issue asked but breaks the project's conventions → **Spec pass, Standards fail.**

Reporting them separately stops one axis from masking another.
