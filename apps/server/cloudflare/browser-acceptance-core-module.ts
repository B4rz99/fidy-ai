import { BunFileSystem } from "@effect/platform-bun";
import { Effect, FileSystem } from "effect";

const coreBundle = new URL("./browser-acceptance-core-bundle.mjs", import.meta.url);
await Effect.runPromise(
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const directory = yield* fs.makeTempDirectoryScoped({
      directory: new URL("./", import.meta.url).pathname,
      prefix: ".browser-acceptance-core-",
    });
    const temporaryBundle = `${directory}/core.mjs`;
    const compiled = Bun.spawnSync([
      "bunx",
      "esbuild",
      new URL("./core-worker.ts", import.meta.url).pathname,
      "--bundle",
      "--platform=node",
      "--format=esm",
      "--packages=external",
      `--alias:cloudflare:workers=${new URL("./workflow-test-runtime.ts", import.meta.url).pathname}`,
      `--outfile=${temporaryBundle}`,
      `--tsconfig=${new URL("../tsconfig.json", import.meta.url).pathname}`,
    ]);
    if (compiled.exitCode !== 0) {
      throw new Error(`Core acceptance fixture failed to compile: ${compiled.stderr.toString()}`);
    }
    // Parallel previews must only observe complete bundles. Keep the rename on one filesystem.
    yield* fs.rename(temporaryBundle, coreBundle.pathname);
  }).pipe(Effect.scoped, Effect.provide(BunFileSystem.layer))
);
// A sibling declaration re-exports core-worker.ts types for this exact compiled artifact.
const coreModule = await import("./browser-acceptance-core-bundle.mjs");
if (
  typeof coreModule.makeCoreWorker !== "function" ||
  typeof coreModule.UserTransactionCoordinator !== "function" ||
  typeof coreModule.runBillingCollectionWorkflow !== "function"
) {
  throw new Error("Core acceptance bundle is missing Worker exports");
}

export const { makeCoreWorker, UserTransactionCoordinator, runBillingCollectionWorkflow } =
  coreModule;
