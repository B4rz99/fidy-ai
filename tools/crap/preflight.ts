// Proves that crap4ts can parse every measured server source before CI spends
// minutes producing coverage. Exit code 1 is expected because the synthetic
// report contains no hits; parser/configuration failures use exit codes 3/2.

import { SOURCE_EXCLUDE, SOURCE_SRC } from "../../apps/server/source-scope.mjs";

const serverRoot = `${import.meta.dir}/../../apps/server`;
const crap4tsCli = `${import.meta.dir}/node_modules/crap4ts/dist/cli.js`;
const excluded = SOURCE_EXCLUDE.map((pattern) => new Bun.Glob(pattern));
const coverage: Record<string, unknown> = {};

const sourcePaths = (
  await Promise.all(
    SOURCE_SRC.map((sourceRoot) =>
      Array.fromAsync(new Bun.Glob(`${sourceRoot}/**/*.ts`).scan({ cwd: serverRoot }))
    )
  )
).flat();
for (const relativePath of sourcePaths) {
  if (excluded.some((pattern) => pattern.match(relativePath))) continue;
  const path = `${serverRoot}/${relativePath}`;
  coverage[path] = {
    path,
    statementMap: {},
    fnMap: {},
    branchMap: {},
    s: {},
    f: {},
    b: {},
  };
}

const temporaryDirectory = `${Bun.env.TMPDIR ?? "/tmp"}/fidy-crap-preflight-${process.pid}`;
const coveragePath = `${temporaryDirectory}/coverage-final.json`;
const makeDirectory = Bun.spawnSync(["mkdir", "-p", temporaryDirectory], { stderr: "pipe" });
if (makeDirectory.exitCode !== 0) {
  process.stderr.write(new TextDecoder().decode(makeDirectory.stderr));
  process.exit(1);
}
try {
  await Bun.write(coveragePath, JSON.stringify(coverage));
  const result = Bun.spawnSync(
    [
      process.execPath,
      crap4tsCli,
      "--coverage",
      coveragePath,
      "--src",
      ...SOURCE_SRC,
      "--exclude",
      ...SOURCE_EXCLUDE,
      "--coverage-metric",
      "line",
      "--strict",
      "--quiet",
    ],
    { cwd: serverRoot, stdout: "pipe", stderr: "pipe" }
  );
  if (result.exitCode !== 0 && result.exitCode !== 1) {
    process.stderr.write(
      new TextDecoder().decode(result.stderr.length > 0 ? result.stderr : result.stdout) ||
        "CRAP parser preflight failed\n"
    );
    process.exit(result.exitCode);
  }
  process.stdout.write(`CRAP parser accepted ${Object.keys(coverage).length} source files\n`);
} finally {
  Bun.spawnSync(["rm", "-rf", temporaryDirectory]);
}
