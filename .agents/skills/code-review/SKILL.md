---
name: code-review
description: "Review the changes since a fixed point (commit, branch, tag, or merge-base) along Architecture, Standards, Security, and Spec, plus Design against DESIGN.md for UI changes. Runs independent reviews in parallel native Codex sub-agents and reports them side by side. Use when the user wants to review a branch, a PR, work-in-progress changes, or asks to \"review since X\"."
---

Review of the diff between `HEAD` and a fixed point the user supplies:

- **Architecture**: does the code conform to this repo's documented architecture?
- **Standards**: does the code conform to this repo's documented coding standards?
- **Security**: does the code satisfy this repo's documented security policy?
- **Spec**: does the code faithfully implement the originating issue / spec?
- **Design** (UI changes only): does the UI follow `DESIGN.md`?

The first four axes are mandatory. Each active axis runs as a **parallel sub-agent** so they don't pollute each other's context, then this skill aggregates their findings. Start every sub-agent with a fresh context window.

Read `docs/agents/issue-tracker.md` for the configured issue tracker. If it is missing, ask which tracker to use.

## Review posture: Zero-Trust

Treat the implementation as flawed until its claims survive examination.

- Treat comments, names, commit messages, and passing tests as claims, not proof. Verify them against executable behavior and authoritative sources.
- For each changed behavior relevant to your axis, attempt to construct a counterexample: an input, state, sequence, or caller that breaks its contract.
- Read surrounding code and trace relevant callers, dependencies, and trust boundaries. The diff locates the change; it does not bound the investigation.
- Report evidence-backed findings: identify the violated rule or requirement, the concrete mismatch or failure path, and its consequence. Distinguish documented violations from heuristic concerns.
- A clean report is earned by investigation, not required by convention. Report no findings when none survive verification; never manufacture one to satisfy the adversarial posture.

## Process

### 1. Pin the fixed point

Whatever the user said is the fixed point (a commit SHA, branch name, tag, `main`, `HEAD~5`, etc.). If they didn't specify one, ask for it.

Capture the diff command once: `git diff <fixed-point>...HEAD` (three-dot, so the comparison is against the merge-base). Also note the list of commits via `git log <fixed-point>..HEAD --oneline`.

Before going further, confirm the fixed point resolves (`git rev-parse <fixed-point>`) and the diff is non-empty. A bad ref or empty diff should fail here, not inside the sub-agents.

Run the existing mechanical gates (`bun run lint`, `bun run lint:type-aware`, `bun run format:check`, `bun run typecheck`) before dispatching reviewers, and again after each round of fixes. If a gate fails, report its failure and stop that iteration until it is fixed; do not ask a reviewer to rediscover it. CI still runs the full `bun run verify` gate.

### 2. Identify the spec source

Look for the originating spec, in this order:

1. Issue references in the commit messages (`#123`, `Closes #45`, GitLab `!67`, etc.), fetched via the workflow in the tracker doc.
2. A path the user passed as an argument.
3. A spec file under `docs/`, `specs/`, or `.scratch/` matching the branch name or feature.
4. If nothing is found, ask the user where the spec is.

### 3. Identify the review sources

Search the repo for every file that documents how code should be written. When `CODING_STANDARDS.md` or `CONTRIBUTING.md` exists, it must be on the list.

Also collect root and affected application `ARCHITECTURE.md` files and relevant ADRs for Architecture, and `SECURITY_STANDARDS.md` for Security. Architectural requirements belong to Architecture even when recorded in a coding-standards document.

Activate Design when changes affect rendered content, layout, styling, assets, shared visual components/tokens, or interaction behavior, including indirect effects through shared code. Otherwise skip it. For affected UI, collect `DESIGN.md` and its applicable approved references; record the affected paths and classification reason.

On top of whatever the repo documents, the Standards axis always carries the **smell baseline** below: a fixed set of Fowler code smells (_Refactoring_, ch.3) that applies even when a repo documents nothing. Two rules bind it:

- **The repo overrides.** A documented repo standard always wins; where it endorses something the baseline would flag, suppress the smell.
- **Always a judgement call.** Each smell is a labelled heuristic ("possible Feature Envy"), never a hard violation. Like any standard here, skip anything tooling already enforces.

Each smell reads *what it is* → *how to fix*; match it against the diff:

- **Mysterious Name**: a function, variable, or type whose name doesn't reveal what it does or holds. → rename it; if no honest name comes, the design's murky.
- **Duplicated Code**: the same logic shape appears in more than one hunk or file in the change. → extract the shared shape, call it from both.
- **Feature Envy**: a method that reaches into another object's data more than its own. → move the method onto the data it envies.
- **Data Clumps**: the same few fields or params keep travelling together (a type wanting to be born). → bundle them into one type, pass that.
- **Primitive Obsession**: a primitive or string standing in for a domain concept that deserves its own type. → give the concept its own small type.
- **Repeated Switches**: the same `switch`/`if`-cascade on the same type recurs across the change. → replace with polymorphism, or one map both sites share.
- **Shotgun Surgery**: one logical change forces scattered edits across many files in the diff. → gather what changes together into one module.
- **Divergent Change**: one file or module is edited for several unrelated reasons. → split so each module changes for one reason.
- **Speculative Generality**: abstraction, parameters, or hooks added for needs the spec doesn't have. → delete it; inline back until a real need shows.
- **Message Chains**: long `a.b().c().d()` navigation the caller shouldn't depend on. → hide the walk behind one method on the first object.
- **Middle Man**: a class or function that mostly just delegates onward. → cut it, call the real target direct.
- **Refused Bequest**: a subclass or implementer that ignores or overrides most of what it inherits. → drop the inheritance, use composition.

### 4. Spawn the active sub-agents in parallel

Issue one native Codex sub-agent call per active axis, in the foreground, and aggregate the reports they return. If concurrency is limited, dispatch the remaining axes as slots become available. Inherit the current model and reasoning effort.

Workers share the caller's checkout and are read-only: no edits, worktrees, commits, or further delegation. Include the **Review posture: Zero-Trust** section in each prompt. Missing required sources, failed reports, or incomplete examination leave an axis unresolved; report these limitations instead of claiming no findings.

**Architecture sub-agent prompt** should include:

- The diff command and commit list.
- The architecture sources collected in step 3.
- The brief: "Report violations of documented boundaries, dependency direction, ownership, and applicable ADRs. Cite the file/hunk, architecture rule, concrete dependency or behavior path, and consequence."

**Standards sub-agent prompt** should include:

- The full diff command and commit list.
- The list of standards-source files you found in step 3, **plus the smell baseline from step 3** pasted in full (the sub-agent has no other access to it).
- The brief: "Report, per file/hunk where relevant, (a) every place the diff violates a documented standard: cite the standard (file + the rule); and (b) any baseline smell you spot: name it and quote the hunk. Distinguish hard violations from judgement calls: documented-standard breaches can be hard, but baseline smells are always judgement calls, and a documented repo standard overrides the baseline. Skip anything tooling enforces. Include every qualifying finding concisely."

**Security sub-agent prompt** should include:

- The diff command and commit list.
- `SECURITY_STANDARDS.md`.
- The brief: "Apply the policy's Finding standard and severity rubric. Report each qualifying finding with its file/hunk, policy section, attack path, impact, remediation, and severity, including missing negative tests required by the policy."

**Spec sub-agent prompt** should include:

- The diff command and commit list.
- The path or fetched contents of the spec.
- The brief: "Report: (a) requirements the spec asked for that are missing or partial; (b) behaviour in the diff that wasn't asked for (scope creep); (c) requirements that look implemented but where the implementation looks wrong. Quote the spec line for each finding. Include every qualifying finding concisely."

**Design sub-agent prompt** should include:

- The diff command, commit list, and affected UI paths.
- The design sources collected in step 3 and available rendered evidence or local UI access instructions.
- The brief: "Report deviations from applicable design rules, respecting their scope, precedence, and approved exceptions. Cite the file/hunk, design section, observed mismatch, and user impact. Inspect rendered UI where appearance or interaction requires it, without mutating application data; identify the relevant screen, state, theme, or viewport."

### 5. Aggregate

Present reports under `## Architecture`, `## Standards`, `## Security`, `## Spec`, and `## Design` headings, verbatim or lightly cleaned. Do **not** merge or rerank findings, because the axes are deliberately separate (see _Why separate axes_). For skipped Design, report "Not applicable — no UI changes" and the classification reason.

End with a one-line summary: total findings per axis, and the worst issue _within each axis_ (if any). Don't pick a single winner across axes: that's the reranking the separation exists to prevent.

### 6. Iterate

After aggregation, apply the findings, refresh the diff against the same fixed point, reassess Design applicability, and rerun the active axes in fresh sub-agents. Finish when all active reviews are complete with no findings; if blocked, report the required input.

## Why separate axes

A change can pass one axis and fail another:

- Code that follows every standard but implements the wrong thing → **Standards pass, Spec fail.**
- Code that does exactly what the issue asked but breaks the project's conventions → **Spec pass, Standards fail.**

Reporting them separately stops one axis from masking the other.
