# Effect native process boundaries

Use for CLI browser handoff or trusted local helper execution. Import `ChildProcess` and
`ChildProcessSpawner` from `effect/process`. Selected Effect 4.0.2 sources:
`node_modules/effect/src/process/{ChildProcess,ChildProcessSpawner}.ts`; inspect `make`,
`CommandOptions`, `KillOptions`, `ChildProcessHandle` and `ChildProcessSpawner.make`.
These APIs describe native processes; provide the platform spawner at CLI assembly, not in Workers.

## Existing recipes

For a best-effort command with no output, follow
[openApprovalBrowser](../apps/cli/src/login/browser.ts): select a known executable, pass argument
arrays to `ChildProcess.make`, ignore unused stdio, await `exitCode` inside `Effect.scoped`, and put
an overall timeout around the scope. Ignore failure only because printed approval instructions are
an intentional fallback.

For required helper output, follow
[authenticateAccess/readToken](../apps/cli/src/support-recovery/internal/access.ts): check each exit
code, consume stdout incrementally with `Stream.runForEach`, count bytes before retaining decoded
text, validate the final output, and map spawn/stream/timeout failures into `RecoveryFailure`.
Keep credentials `Redacted` after decoding and wipe the retained value on a subsequent failed exit.

## Arguments, termination and output

Use a fixed executable and separate arguments with shell execution disabled. Argument arrays avoid
shell interpolation but do not validate the target program's flags or URL semantics: allowlist inputs
and use an end-of-options separator when the executable supports it. Keep credentials out of argv,
diagnostics and broad inherited context; configure environment, cwd and stdio deliberately.

Yielding a `ChildProcess.make` command obtains a scoped handle through `ChildProcessSpawner`.
Scope release owns termination. Set `forceKillAfter` when shutdown must escalate: the default is
undefined and never sends SIGKILL. Descendant termination and signal behavior depend on the selected
platform spawner, so verify its implementation for process-tree requirements. A timeout bounds useful
work; finalizer termination can add time after that deadline.

A nonzero `exitCode` is a value to classify, not an automatic domain failure. Drain every piped stream
that can fill while awaiting completion, or ignore an unused stream. `ChildProcessSpawner.string`
and `lines` collect output without an application byte cap; use streaming for untrusted/unbounded
output. A line count alone does not bound a single line. Cap stdout and stderr independently and
cancel the scoped process when the cap is crossed. Keep partial output out of public errors.

## Test seam

Supply `ChildProcessSpawner.make` with a fake `spawn` returning a `makeHandle` handle. This preserves
command construction and owner policy while substituting the OS. Assert executable/arguments/stdin,
nonzero exit handling, streamed byte overflow, timeout/interruption and finalizer release. A fake
spawner proves owner behavior; a small platform integration test is needed to establish actual signal
escalation and descendant cleanup when those are requirements.
