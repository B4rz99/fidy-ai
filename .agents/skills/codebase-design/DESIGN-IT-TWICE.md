# Design It Twice

When the user wants to explore alternative interfaces for a chosen deepening candidate, use this parallel Herdr Pi-worker pattern. Based on "Design It Twice" (Ousterhout) — your first idea is unlikely to be the best.

Uses the vocabulary in [SKILL.md](SKILL.md) — **module**, **interface**, **seam**, **adapter**, **leverage**.

## Process

### 1. Frame the problem space

Before spawning workers, write a user-facing explanation of the problem space for the chosen candidate:

- The constraints any new interface would need to satisfy
- The dependencies it would rely on, and which category they fall into (see [DEEPENING.md](DEEPENING.md))
- A rough illustrative code sketch to ground the constraints — not a proposal, just a way to make the constraints concrete

Show this to the user, then immediately proceed to Step 2. The user reads and thinks while the workers work in parallel.

### 2. Spawn read-only Herdr Pi workers

Delegation requires a Herdr-managed pane. Check this before creating any worker:

```bash
test "${HERDR_ENV:-}" = 1
```

If the check fails, stop and report that this exploration requires Herdr. Do not fall back to an API call, an in-process sub-agent, or another agent CLI.

Spawn 3+ **read-only** workers in parallel in the caller's current checkout. Follow `/herdr`'s **Spawn skill-driven Pi workers** procedure: inspect the layout, create sibling panes with `--no-focus`, parse returned pane IDs, start every worker, wait for `idle`, submit each task, confirm every worker is `working`, then collect `idle`/`done` reports with `herdr agent read`. Launch every worker with the invoking session's values:

```bash
herdr pane run <pane-id> "pi --model ${PI_PROVIDER:?PI_PROVIDER must be set}/${PI_MODEL:?PI_MODEL must be set} --thinking ${PI_REASONING_LEVEL:?PI_REASONING_LEVEL must be set} --exclude-tools edit,write"
```

This preserves the current Codex-backed model, reasoning level, and authentication path. Do not use `herdr agent start --kind codex`, an API provider/key, `-p`, or `--no-session`. Close only the panes created for this exploration after reading their reports. A missing, blocked, unknown, or failed report is unresolved.

Each worker must produce a **radically different** interface for the deepened module. Tell each worker to inspect only and not edit files, create worktrees, or commit. Prompt each worker with a separate technical brief (file paths, coupling details, dependency category from [DEEPENING.md](DEEPENING.md), what sits behind the seam). The brief is independent of the user-facing problem-space explanation in Step 1. Give each worker a different design constraint:

- Worker 1: "Minimize the interface — aim for 1–3 entry points max. Maximise leverage per entry point."
- Worker 2: "Maximise flexibility — support many use cases and extension."
- Worker 3: "Optimise for the most common caller — make the default case trivial."
- Worker 4 (if applicable): "Design around ports & adapters for cross-seam dependencies."

Include both [SKILL.md](SKILL.md) vocabulary and CONTEXT.md vocabulary in the brief so each worker names things consistently with the architecture language and the project's domain language.

Each worker outputs:

1. Interface (types, methods, params — plus invariants, ordering, error modes)
2. Usage example showing how callers use it
3. What the implementation hides behind the seam
4. Dependency strategy and adapters (see [DEEPENING.md](DEEPENING.md))
5. Trade-offs — where leverage is high, where it's thin

### 3. Present and compare

Present designs sequentially so the user can absorb each one, then compare them in prose. Contrast by **depth** (leverage at the interface), **locality** (where change concentrates), and **seam placement**.

After comparing, give your own recommendation: which design you think is strongest and why. If elements from different designs would combine well, propose a hybrid. Be opinionated — the user wants a strong read, not a menu.
