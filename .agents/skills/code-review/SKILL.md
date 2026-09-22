---
name: code-review
description: Review the changes since a fixed point (commit, branch, tag, or merge-base) along three axes — Standards (does the code follow this repo's documented coding and architecture standards?), Security (does it satisfy the repo's documented security policy?), and Spec (does the code match what the originating issue/spec asked for?). Runs read-only reviews as parallel Herdr-managed Pi workers using the invoking session's model and reasoning level, then reports them side by side. Use when the user wants to review a branch, a PR, work-in-progress changes, or asks to "review since X".
---

Three-axis review of the diff between `HEAD` and a fixed point the user supplies:

- **Standards** — does the code conform to this repo's documented coding and architecture standards?
- **Security** — does the code satisfy this repo's documented security policy?
- **Spec** — does the code faithfully implement the originating issue / spec?

Each active axis runs as a **parallel Herdr-managed Pi worker** so the reviews don't pollute each other's context, then this skill aggregates their findings. The workers are read-only and share the caller's checkout.

The issue tracker should have been provided to you — run `/setup-matt-pocock-skills` if `docs/agents/issue-tracker.md` is missing.

## Process

### 1. Pin the fixed point

Whatever the user said is the fixed point — a commit SHA, branch name, tag, `main`, `HEAD~5`, etc. If they didn't specify one, ask for it.

Capture the diff command once: `git diff <fixed-point>...HEAD` (three-dot, so the comparison is against the merge-base). Also note the list of commits via `git log <fixed-point>..HEAD --oneline`.

Before going further, confirm the fixed point resolves (`git rev-parse <fixed-point>`) and the diff is non-empty. A bad ref or empty diff should fail here — not inside the Herdr workers.

### 2. Identify the spec source

Look for the originating spec, in this order:

1. Issue references in the commit messages (`#123`, `Closes #45`, GitLab `!67`, etc.) — fetch via the workflow in `docs/agents/issue-tracker.md`.
2. A path the user passed as an argument.
3. A spec file under `docs/`, `specs/`, or `.scratch/` matching the branch name or feature.
4. If nothing is found, ask the user where the spec is. If they say there isn't one, the **Spec** worker will skip and report "no spec available".

### 3. Identify the standards and security sources

Build explicit, repo-relative source lists for each worker:

- **Standards sources** — coding standards such as `CODING_STANDARDS.md` or `CONTRIBUTING.md`, plus
  the architecture documents required by the repository's agent instructions for the changed paths.
- **Security sources** — security policy such as `SECURITY_STANDARDS.md`.

For this repository, list `SECURITY_STANDARDS.md` explicitly in the Security sources.

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

### 4. Spawn the active reviewers as Herdr Pi workers

Delegation requires a Herdr-managed pane. Check this before creating any worker:

```bash
test "${HERDR_ENV:-}" = 1
```

If the check fails, stop and report that this review requires Herdr. Do not fall back to an API call, an in-process sub-agent, or a different agent CLI.

All active reviewers are read-only, so keep them in the caller's current checkout. Follow `/herdr`'s **Spawn skill-driven Pi workers** procedure exactly:

1. Inspect the current layout and create one sibling pane per active axis with `--no-focus`. Parse the returned pane IDs; never construct them.
2. Start every worker before sending any task. Launch each with the invoking session's exact `PI_PROVIDER`, `PI_MODEL`, and `PI_REASONING_LEVEL`:

   ```bash
   herdr pane run <pane-id> "pi --model ${PI_PROVIDER:?PI_PROVIDER must be set}/${PI_MODEL:?PI_MODEL must be set} --thinking ${PI_REASONING_LEVEL:?PI_REASONING_LEVEL must be set} --exclude-tools edit,write"
   ```

   This launches Pi through the current Codex-backed auth/model selection. Do not use `herdr agent start --kind codex`, `--provider openai`, an API key, `-p`, or `--no-session`.

3. Wait for every worker to reach `idle` with `herdr agent wait <pane-id> --until idle --timeout 30000`.
4. Submit every self-contained task with `herdr agent prompt`. Tell each worker to perform its assigned review itself in that worker, at one delegation level only. Keep it read-only: do not edit files, create worktrees, commit, spawn or prompt other agents, or invoke another review skill. Include the full diff command, commit list, named source paths or excerpts, and the axis brief below. The Standards prompt carries a literal `Standards sources` block. The Security prompt carries a literal `Security sources` block with `SECURITY_STANDARDS.md` and asks the worker to read it before reviewing.
5. Confirm every worker reaches `working` before collecting any result.
6. Wait for each worker to reach `idle` or `done` with `herdr agent wait <pane-id> --until idle --until done --timeout 120000`, then read it with `herdr agent read <pane-id> --source recent-unwrapped --lines 160`.
7. Treat a missing, blocked, unknown, or failed report as unresolved. Close only the panes created for this iteration after reading their reports.

**Standards worker brief** — first read every path in the prompt's `Standards sources` block. Review documented coding and architecture standards and the smell baseline only. Report per file/hunk where relevant (a) every place the diff violates a documented standard, citing the source file and rule; and (b) any baseline smell, naming it and quoting the hunk. Distinguish hard documented-standard breaches from judgement calls. A documented repo standard overrides the baseline. Skip tooling-enforced issues. Report exactly "No standards findings." when none qualify. Stay under 400 words.

**Security worker brief** — first read every path in the prompt's `Security sources` block. Apply the policy's Finding standard and severity rubric. Report each qualifying finding with its file/hunk, policy section, attack path, impact, remediation, and severity. A missing required negative test qualifies when the policy requires one. Report exactly "No security findings." when none qualify. Stay under 400 words.

**Spec worker brief** — report (a) requirements the spec asked for that are missing or partial; (b) behaviour in the diff that was not asked for (scope creep); and (c) requirements that look implemented but where the implementation looks wrong. Quote the spec line for each finding. Report exactly "No spec findings." when none qualify. Stay under 400 words.

If the spec is missing, skip the Spec worker and note this in the final report.

### 5. Aggregate

Present the active reports under `## Standards`, `## Security`, and `## Spec` headings, in that order, verbatim or lightly cleaned. If an axis was skipped, state why under its heading. Do **not** merge or rerank findings — the three axes are deliberately separate (see _Why three axes_).

End with a one-line summary: total findings per axis, and the worst issue _within each axis_ (if any). Don't pick a single winner across axes — that's the reranking the separation exists to prevent.

### 6. Iterate

Run the review as `review → fix → review`. After aggregation, close that iteration's panes, apply the findings, refresh the diff against the same fixed point, and rerun every active axis in fresh panes. Finish when every active axis reports its no-findings result.

## Why three axes

A change can pass one axis and fail another:

- Code that follows coding standards but has an authorization flaw → **Standards pass, Security fail.**
- Code that is secure but implements the wrong thing → **Security pass, Spec fail.**
- Code that does exactly what the issue asked but breaks the project's conventions → **Spec pass, Standards fail.**

Reporting them separately stops one axis from masking another.
