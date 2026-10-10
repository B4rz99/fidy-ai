import { Effect } from "effect";
import { ChildProcess, type ChildProcessSpawner } from "effect/process";

/** Scoped, bounded best-effort browser handoff; printed public instructions remain the fallback. */
export const openApprovalBrowser = (
  url: string
): Effect.Effect<void, never, ChildProcessSpawner.ChildProcessSpawner> => {
  let executable = "xdg-open";
  let args = [url];
  if (process.platform === "darwin") executable = "open";
  if (process.platform === "win32") {
    executable = "rundll32.exe";
    args = ["url.dll,FileProtocolHandler", url];
  }
  return Effect.gen(function* () {
    const child = yield* ChildProcess.make(executable, args, {
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
      forceKillAfter: "1 second",
    });
    yield* child.exitCode;
  }).pipe(Effect.scoped, Effect.timeoutOption("5 seconds"), Effect.ignore);
};
