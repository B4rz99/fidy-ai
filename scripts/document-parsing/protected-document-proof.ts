import { readProofOutput, stopProofProcess } from "./proof-command";
import { stat } from "node:fs/promises";
import { Data, Effect, Fiber } from "effect";

class ProtectedProofFailure extends Data.TaggedError("ProtectedProofFailure")<{
  readonly message: string;
}> {}

const startupWaitMilliseconds = Number("5000");

const serverPort = 8794;

type ProofOptions = {
  readonly configPath: string;
  readonly infrastructureRoot: string;
  readonly temporaryDirectory: string;
  readonly wranglerPath: string;
};

const stopWorker = (process: Bun.Subprocess): Effect.Effect<void> =>
  stopProofProcess(process).pipe(Effect.orDie);

const startWorker = (options: ProofOptions): Bun.Subprocess<"pipe", "ignore", "pipe"> =>
  Bun.spawn(
    [
      options.wranglerPath,
      "dev",
      "--config",
      options.configPath,
      "--port",
      String(serverPort),
      "--persist-to",
      `${options.temporaryDirectory}/protected-state`,
      "--no-show-interactive-dev-session",
    ],
    { cwd: options.infrastructureRoot, stderr: "pipe", stdout: "ignore" }
  );

export const runProtectedDocumentProof = Effect.fn(function* (options: ProofOptions) {
  const bundlePath = `${options.temporaryDirectory}/protected-document-worker.js`;

  const build = Bun.spawnSync(
    [
      options.wranglerPath,
      "deploy",
      "--dry-run",
      "--config",
      options.configPath,
      "--outfile",
      bundlePath,
    ],
    {
      cwd: options.infrastructureRoot,
      stderr: "inherit",
      stdout: "pipe",
      timeout: 120_000,
      maxBuffer: 1_048_576,
      killSignal: "SIGKILL",
    }
  );

  if (build.exitCode !== 0) {
    return yield* new ProtectedProofFailure({ message: "Protected-document proof did not bundle" });
  }

  const bundleBytes = (yield* Effect.tryPromise(() => stat(bundlePath))).size;

  const failure = yield* Effect.scoped(
    Effect.gen(function* () {
      const worker = yield* Effect.acquireRelease(
        Effect.sync(() => startWorker(options)),
        stopWorker
      );

      const diagnostics = yield* Effect.forkScoped(readProofOutput(worker.stderr));
      yield* Effect.sleep(startupWaitMilliseconds);
      yield* stopWorker(worker);
      const stderr = yield* Fiber.join(diagnostics);
      yield* Effect.tryPromise(() => worker.exited);

      return stderr;
    })
  );

  if (!failure.includes("createRequire") || !failure.includes("runtime failed to start")) {
    return yield* new ProtectedProofFailure({
      message: "Pinned protected-document candidate no longer has its measured failure",
    });
  }

  return bundleBytes;
});
