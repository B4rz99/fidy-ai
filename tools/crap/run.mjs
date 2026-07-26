// Runs the crap4ts CRAP-score gate against the coverage report produced by
// `vitest run --config vitest.crap.config.ts --coverage`.
//
// crap4ts is spawned from this directory's isolated node_modules so it resolves
// the classic `typescript` pinned here rather than the root's Effect tsgo build,
// which it cannot parse with. The child inherits this process's cwd (the repo
// root), so the coverage path and source globs below are repo-root-relative and
// line up with the paths recorded in coverage-final.json.
//
// Source scope is imported from the repo-root source-scope module so the
// coverage run and this analysis stay in lockstep — one source of truth.

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { SOURCE_EXCLUDE, SOURCE_SRC } from "../../source-scope.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const crap4tsCli = resolve(here, "node_modules/crap4ts/dist/cli.js");

const args = [
  crap4tsCli,
  "--coverage",
  "coverage/coverage-final.json",
  "--src",
  ...SOURCE_SRC,
  "--exclude",
  ...SOURCE_EXCLUDE,
  "--coverage-metric",
  "line",
  "--top",
  "30",
  "--strict",
];

const child = spawn(process.execPath, args, { stdio: "inherit" });
child.on("exit", (code, signal) => {
  if (signal !== null) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 1);
});
