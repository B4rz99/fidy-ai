import { stat } from "node:fs/promises";
import { Effect } from "effect";

const startupWaitMilliseconds = Number("5000");
const serverPort = 8794;

type ProofOptions = {
  readonly configPath: string;
  readonly infrastructureRoot: string;
  readonly temporaryDirectory: string;
  readonly wranglerPath: string;
};

const stopWorker = (process: Bun.Subprocess): Effect.Effect<void> =>
  Effect.sync(() => process.kill()).pipe(
    Effect.flatMap(() => Effect.tryPromise(() => process.exited)),
    Effect.asVoid,
    Effect.orDie
  );

const startWorker = (options: ProofOptions): Bun.Subprocess<"pipe", "pipe", "pipe"> =>
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
    { cwd: options.infrastructureRoot, stderr: "pipe", stdout: "pipe" }
  );

/** Bundles the pinned candidate and verifies its known workerd startup failure. */
export const runProtectedDocumentProof = (options: ProofOptions): Promise<number> =>
  Effect.runPromise(
    Effect.gen(function* () {
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
        { cwd: options.infrastructureRoot, stderr: "inherit", stdout: "pipe" }
      );
      if (build.exitCode !== 0) throw new Error("Protected-document proof did not bundle");
      const bundleBytes = (yield* Effect.tryPromise(() => stat(bundlePath))).size;
      const failure = yield* Effect.scoped(
        Effect.gen(function* () {
          const worker = yield* Effect.acquireRelease(
            Effect.sync(() => startWorker(options)),
            stopWorker
          );
          yield* Effect.sleep(startupWaitMilliseconds);
          worker.kill();
          const stderr = yield* Effect.tryPromise(() => new Response(worker.stderr).text());
          yield* Effect.tryPromise(() => worker.exited);
          return stderr;
        })
      );
      if (!failure.includes("createRequire") || !failure.includes("runtime failed to start")) {
        throw new Error("Pinned protected-document candidate no longer has its measured failure");
      }
      return bundleBytes;
    })
  );
