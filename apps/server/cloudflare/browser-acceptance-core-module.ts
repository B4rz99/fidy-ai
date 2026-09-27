import type * as CoreWorkerModule from "./core-worker";

const coreBundle = new URL("../node_modules/.cache/browser-acceptance-core.mjs", import.meta.url);
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
// The fixture imports exactly the artifact compiled from the typed source above; the generated
// URL has no TypeScript declaration. The export check detects a missing or mismatched artifact.
const coreModule: typeof CoreWorkerModule = await import(coreBundle.href);
if (
  typeof coreModule.makeCoreWorker !== "function" ||
  typeof coreModule.UserTransactionCoordinator !== "function" ||
  typeof coreModule.runBillingCollectionWorkflow !== "function"
) {
  throw new Error("Core acceptance bundle is missing Worker exports");
}

export const { makeCoreWorker, UserTransactionCoordinator, runBillingCollectionWorkflow } =
  coreModule;
