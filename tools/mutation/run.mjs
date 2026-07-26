// Runs the StrykerJS mutation gate against the core tree, configured by the
// repo-root stryker.config.mjs.
//
// Stryker is spawned from this directory's isolated node_modules so it resolves
// the classic `typescript` pinned here rather than the root's Effect tsgo build,
// which it cannot rewrite the sandbox tsconfig with. Node resolution walks
// upward from the package doing the importing, so the vitest runner plugin —
// living here — still finds the root's `vitest`, which is the one
// vitest.core.config.ts configures. That asymmetry is the whole trick: classic
// typescript is shadowed locally, vitest deliberately is not (see bunfig.toml).
//
// The child inherits this process's cwd (the repo root), so every path in the
// config is repo-root-relative, exactly as the vitest and coverage configs are.

// Node, not Bun, and this is the one tool in the repo that cannot be either:
// Stryker's Babel instrumenter throws on the Bun runtime before it plants a
// mutant. The failure it throws there is a stack inside @babel/core with no
// mention of the runtime, so the check is here to say what actually went wrong.

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

if (process.versions.bun !== undefined) {
  console.error(
    "The mutation gate runs on Node: Stryker's instrumenter does not work on Bun.\n" +
      "Run `bun run test:mutation`, or `node tools/mutation/run.mjs` directly."
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
  process.exit(code ?? 1);
});
