// Runs the crap4ts CRAP-score gate against the merged coverage report produced
// by the sharded CI suite.
//
// crap4ts is spawned from this directory's isolated node_modules so it resolves
// the classic `typescript` pinned here rather than the root's Effect tsgo build,
// which it cannot parse with. The child runs from the server package root, so the
// coverage path and source globs below are package-relative and line up with the
// paths recorded in coverage-final.json.
//
// Source scope is imported from the server package's source-scope module so the
// coverage run and this analysis stay in lockstep — one source of truth.

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { SOURCE_EXCLUDE, SOURCE_SRC } from "../../apps/server/source-scope.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const crap4tsCli = resolve(here, "node_modules/crap4ts/dist/cli.js");
const serverRoot = resolve(here, "../../apps/server");

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

const child = spawn(process.execPath, args, { cwd: serverRoot, stdio: "inherit" });
child.on("exit", (code, signal) => {
  if (signal !== null) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 1);
});
