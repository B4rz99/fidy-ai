// Stryker requires Node for Babel instrumentation and the classic TypeScript compiler API.

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { loadMutationReport, loadRegistry, verifyEquivalentReport } from "./equivalents.mjs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

if (Object.hasOwn(process.versions, "bun")) {
  console.error(
    "The mutation check runs on Node: Stryker's instrumenter does not work on Bun.\n" +
      "Run `bun run test:mutation`, or `cd apps/server && node ../../tools/mutation/run.mjs` directly."
  );
  process.exit(1);
}

const here = dirname(fileURLToPath(import.meta.url));
const strykerCli = resolve(here, "node_modules/@stryker-mutator/core/bin/stryker.js");

const child = spawn(process.execPath, [strykerCli, "run", ...process.argv.slice(2)], {
  stdio: "inherit",
});
child.on("exit", (code, signal) => {
  if (signal !== null) {
    process.kill(process.pid, signal);
    return;
  }
  if (code === 0 && existsSync(resolve("src/core")) && process.argv.length === 2) {
    const report = loadMutationReport(resolve("reports/mutation/mutation.json"));
    verifyEquivalentReport(loadRegistry(), report);
  }
  process.exit(code ?? 1);
});
