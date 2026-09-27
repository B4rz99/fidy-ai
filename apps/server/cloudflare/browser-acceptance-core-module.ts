const coreBundle = new URL("./browser-acceptance-core-bundle.mjs", import.meta.url);
const compiled = Bun.spawnSync([
  "bunx",
  "esbuild",
  new URL("./core-worker.ts", import.meta.url).pathname,
  "--bundle",
  "--platform=node",
  "--format=esm",
  "--packages=external",
  `--alias:cloudflare:workers=${new URL("./workflow-test-runtime.ts", import.meta.url).pathname}`,
  `--outfile=${coreBundle.pathname}`,
  `--tsconfig=${new URL("../tsconfig.json", import.meta.url).pathname}`,
]);
if (compiled.exitCode !== 0) {
  throw new Error(`Core acceptance fixture failed to compile: ${compiled.stderr.toString()}`);
}
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
