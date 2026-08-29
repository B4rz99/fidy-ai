---
name: herdr
description: "Control Herdr, a terminal multiplexer for coding agents. Use when the user explicitly mentions Herdr or when a skill needs isolated or parallel work in this harness. Use it to inspect or control panes, tabs, workspaces, terminals, commands, or communication with another agent. Requires HERDR_ENV=1."
---

# Herdr

Herdr is a terminal multiplexer and runtime for coding agents. It organizes terminals into workspaces, tabs, and panes, detects agent identity and status, and exposes the running session through the `herdr` CLI.

Before issuing any control command, check that this agent is running inside a Herdr-managed pane:

```bash
test "${HERDR_ENV:-}" = 1
```

If the check fails, say that you are not running inside Herdr and stop. Do not inspect or control the focused Herdr session from outside Herdr.

When the check passes, the `herdr` binary in `PATH` talks to the running session. Use it to inspect neighboring work, create isolated terminal contexts, start agents and commands, read their output, and wait for state changes.

## Learn the current CLI

The installed binary is the authority for command syntax. Begin with:

```bash
herdr --help
```

Then print the relevant command group by running it without a subcommand:

```bash
herdr pane
herdr workspace
herdr worktree
herdr tab
herdr agent
herdr terminal
herdr notification
herdr integration
herdr session
```

Do not run bare `herdr` for discovery; it launches or attaches the TUI. Do not probe a mutating nested command by omitting arguments; some commands, including `herdr workspace create`, are valid with defaults and will execute. Use the command-group output above instead.

Most control commands print JSON. Read identifiers and state from those responses instead of predicting either one.

## IDs and current context

Public IDs are short stable handles:

- workspace: `w1`
- tab: `w1:t1`
- pane: `w1:p1`
- terminal: `term_...`

The encoded suffix can contain letters and can grow beyond one character. Treat every ID as an opaque string.

Closed tab and pane IDs are not reused and do not retarget later resources. A pane moved into another workspace receives a new public pane ID. Re-read create, split, move, list, or get responses after mutations; never construct an ID from a workspace or display number.

Herdr injects the caller's stable context into every managed pane:

```bash
printf '%s\n' "$HERDR_WORKSPACE_ID" "$HERDR_TAB_ID" "$HERDR_PANE_ID"
```

Prefer `--current` when a pane command should target the calling pane. Omitting a target can use the UI-focused pane, which may belong to the user or another client.

Discover live state with:

```bash
herdr workspace list
herdr tab list --workspace "$HERDR_WORKSPACE_ID"
herdr pane current --current
herdr pane list --workspace "$HERDR_WORKSPACE_ID"
```

## Control agents through panes

An agent runs inside a pane. Use the pane ID as the control target for agents, shells, servers, tests, and logs. This keeps spawning, input, reads, waits, and cleanup on one stable control surface.

Use workspace and tab commands for organization. Use worktree commands only when you intentionally want Herdr to create, open, or remove a Git checkout.

Pane records expose `agent`, `agent_status`, and native session metadata when available. Agent status is `idle`, `working`, `blocked`, `done`, or `unknown`.

`idle` and `done` are the same underlying semantic state with different attention state:

- `idle`: the agent is waiting and its result is considered seen.
- `done`: the agent finished and its result has not been seen.

An agent that first opens at its prompt reports `idle`, including in a background pane. After a working or blocked agent completes, it reports `done` when its tab or workspace is in the background. It reports `idle` when it completes in the active tab while the foreground client is focused. If the foreground client is explicitly unfocused, completion can become `done` even in the active tab.

Focusing a pane, switching to its tab, or regaining outer terminal focus marks the visible tab as seen, so `done` becomes `idle`. Switching away does not turn an existing `idle` status into `done`; `done` is created by a later completion while the pane is unseen. With no foreground client, a new completion in the globally active tab is treated as seen while completions in background tabs still become `done`.

## Start agents interactively

Default to a sibling pane in the current tab and current working directory. Do not create a workspace, tab, worktree, or different cwd unless the user explicitly requests that topology or location.

Honor a direction requested by the user. Otherwise inspect the caller pane's current rectangle:

```bash
herdr pane layout --pane "$HERDR_PANE_ID"
```

Split a wide pane to the right and a narrow or tall pane down. Avoid repeated same-direction splits that would create unusably narrow columns or short rows. Keep the user's focus in the calling pane:

```bash
herdr pane split --current --direction right --no-focus
```

Replace `right` with `down` when the layout calls for it.

Read `result.pane.pane_id` from the JSON response. Give the pane a useful label, then start the requested agent by running only its normal executable so its interactive TUI opens:

```bash
herdr pane rename <returned-pane-id> "reviewer"
herdr pane run <returned-pane-id> "codex"
```

Use the executable that belongs to the requested agent:

- Codex: `codex`
- Claude Code: `claude`
- pi: `pi`
- OpenCode: `opencode`
- OMP: `omp`

Do not pass the task as an argv prompt by default. Do not add non-interactive flags. Only change the normal interactive launch when the user explicitly asks for a different launch mode or command.

Inspect the pane after launch. If `agent_status` is not yet `idle`, wait for the idle transition. Once it is idle, submit the task with `agent prompt`:

```bash
herdr agent get <returned-pane-id>
herdr agent wait <returned-pane-id> --until idle --timeout 30000
herdr agent prompt <returned-pane-id> "Review the current diff and report only actionable findings."
```

Status waits match the current status immediately or wait for a future matching transition.

`pane run` sends the text and Enter together. Use it for initial prompts and follow-ups instead of coordinating `send-text` and `send-keys` separately.

For normal background work, wait for the agent to start working. If the pane remains in a background tab or workspace, wait for `done` before reading its transcript:

```bash
herdr agent wait <returned-pane-id> --until working --timeout 30000
herdr agent wait <returned-pane-id> --until done --timeout 120000
herdr agent read <returned-pane-id> --source recent-unwrapped --lines 120
```

If the user is watching that tab, completion reports `idle` instead, so wait for `idle`. Always treat either `idle` or `done` as completed when inspecting `pane get`; the difference is whether the result has been seen.

If a wait times out, inspect `herdr pane get <returned-pane-id>` and `herdr pane read <returned-pane-id> --source recent-unwrapped --lines 120` before deciding what to do. A `blocked` agent needs input; an `unknown` pane may not yet contain a detected or integrated agent.

Submit follow-ups the same way:

```bash
herdr agent prompt <returned-pane-id> "Now check the failing test."
```

## Spawn skill-driven Pi workers

When another skill delegates isolated or parallel work, use this Herdr workflow instead of an in-process or API delegation tool. This workflow requires `HERDR_ENV=1`; if that check fails, stop and report that the work requires Herdr.

1. Classify the worker before spawning it:
   - **Read-only** workers may use the caller's current checkout.
   - Any worker that creates or edits files gets its own Herdr Git worktree. Create it with `herdr worktree create`, parse the returned workspace and pane IDs, and run the worker there. Never let parallel workers write to the same checkout.
2. Create one sibling pane per read-only task with `herdr pane split --current`, choosing each split direction from the current layout and using `--no-focus`. Parse every pane ID from Herdr's JSON response, then give each pane a task-specific label. For worktree-backed workers, use the pane created by `herdr worktree create` or `herdr worktree open` and parse its returned IDs instead of constructing them.
3. Start an interactive Pi using the calling session's provider, model, and current reasoning level in every pane, expanding them directly into the launch command:

   ```bash
   herdr pane run <pane-id> "pi --model ${PI_PROVIDER:?PI_PROVIDER must be set}/${PI_MODEL:?PI_MODEL must be set} --thinking ${PI_REASONING_LEVEL:?PI_REASONING_LEVEL must be set}"
   ```

   Pi documents `PI_PROVIDER`, `PI_MODEL`, and `PI_REASONING_LEVEL` as the effective session values injected into bash commands. This command therefore snapshots the invoking session's current model, effort, and authentication path. For a read-only worker, append `--exclude-tools edit,write`; keep `bash` available when the task needs git or test inspection. Do not replace it with a hard-coded model, the `openai` API provider, an API key, `-p`, or `--no-session`.

4. Wait until every Pi reports `idle`, then submit one self-contained task with `herdr agent prompt`. Include all paths, commands, criteria, and reference text the worker needs; workers do not share the caller's conversation context.
5. For parallel work, start every worker and confirm every pane reaches `working` before waiting for any result. Use `herdr agent wait <pane-id> --until working`; then accept `idle` or `done` as completion only after that worker was observed working.
6. Read each completed transcript with `herdr agent read <pane-id> --source recent-unwrapped`. A missing, blocked, unknown, or failed worker result remains unresolved; report it rather than silently doing that worker's task in the caller.
7. Close only panes and worktree workspaces created by this delegation after reading their reports and preserving or returning their artifacts. Never close resources owned by the user or another skill.

The inherited provider and model preserve the calling session's model, credentials, and normal Pi settings. Existing workers keep their snapshot if the parent changes later; subsequently spawned workers inherit the new values.

## Run an ordinary command in another pane

Split the calling pane using the same geometry rule without moving the user's focus:

```bash
herdr pane split --current --direction right --no-focus
```

Read the new `pane_id` from the JSON response, then run and inspect the command:

```bash
herdr pane run <returned-pane-id> "just test"
herdr pane wait-output <returned-pane-id> --match "test result" --timeout 120000
herdr pane read <returned-pane-id> --source recent-unwrapped --lines 120
```

Inspect existing output before waiting for future output. A wait timeout exits with status `1`.

Use the read source that matches the task:

- `visible`: the current rendered viewport
- `recent`: recent scrollback as rendered, including soft wraps
- `recent-unwrapped`: recent scrollback with soft wraps joined; prefer it for logs and transcripts
- `detection`: the bottom-buffer snapshot used by agent detection

Use `--format ansi` when colors and terminal styling are evidence. Otherwise use text.

If the user explicitly asks for another tab, workspace, or worktree, discover that command group and use returned IDs. Do not infer a larger topology from a request to start an agent or command.

## Safety and coordination rules

- Use `--no-focus` for background work unless the user asked to switch context.
- Use `--current` or an explicit ID. Do not rely on another client's focused pane.
- Parse IDs from JSON responses. Do not derive them from sidebar order or examples.
- Inspect before waiting. Read current output first, then wait for the next state or output you expect.
- Do not close workspaces, tabs, panes, or sessions you did not create unless the user explicitly asked.
- Never run `herdr server stop` from an active session unless the user explicitly intends to stop the server and its pane processes.
- Never kill the main Herdr process. Use named test sessions for experiments that need an isolated server.
