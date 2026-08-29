import { Option } from "effect";
import { afterEach, describe, expect, it } from "vitest";

const repositoryRoot = process.cwd();
const mergeScript = `${repositoryRoot}/scripts/ci/merge-server-coverage.ts`;
const temporaryDirectories: string[] = [];
let directorySequence = 0;

type CoverageCounts = {
  readonly branches: readonly [number, number];
  readonly functions: number;
  readonly statements: number;
};

const coverageFor = (path: string, counts: CoverageCounts): object => ({
  [path]: {
    path,
    statementMap: {
      "0": { start: { line: 1, column: 0 }, end: { line: 1, column: 1 } },
    },
    fnMap: {
      "0": {
        name: "coveredFunction",
        decl: { start: { line: 1, column: 0 }, end: { line: 1, column: 1 } },
        loc: { start: { line: 1, column: 0 }, end: { line: 1, column: 1 } },
        line: 1,
      },
    },
    branchMap: {
      "0": {
        loc: { start: { line: 1, column: 0 }, end: { line: 1, column: 1 } },
        type: "if",
        locations: [
          { start: { line: 1, column: 0 }, end: { line: 1, column: 1 } },
          { start: { line: 1, column: 0 }, end: { line: 1, column: 1 } },
        ],
        line: 1,
      },
    },
    s: { "0": counts.statements },
    f: { "0": counts.functions },
    b: { "0": counts.branches },
  },
});

type CommandResult = Readonly<{
  exitCode: number;
  stdout: Uint8Array;
  stderr: Uint8Array;
}>;

const decode = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);
const run = (command: ReadonlyArray<string>, stdin?: string): CommandResult => {
  const result = Bun.spawnSync([...command], {
    cwd: repositoryRoot,
    stdin: stdin === undefined ? undefined : new TextEncoder().encode(stdin),
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    exitCode: result.exitCode,
    stdout: Option.getOrElse(Option.fromUndefinedOr(result.stdout), () => new Uint8Array()),
    stderr: Option.getOrElse(Option.fromUndefinedOr(result.stderr), () => new Uint8Array()),
  };
};
const writeJson = (path: string, value: object): void => {
  const result = run(["tee", path], JSON.stringify(value));
  if (result.exitCode !== 0) throw new Error(decode(result.stderr));
};
const makeInput = (): string => {
  directorySequence += 1;
  const root = `${Bun.env.TMPDIR ?? "/tmp"}/fidy-coverage-${process.pid}-${directorySequence}`;
  const result = run(["mkdir", "-p", `${root}/shard-1`, `${root}/shard-2`]);
  if (result.exitCode !== 0) throw new Error(decode(result.stderr));
  temporaryDirectories.push(root);
  return root;
};
const runMerge = (input: string, output: string): CommandResult =>
  run(["bun", mergeScript, "--input", input, "--output", output]);

afterEach(() => {
  for (const path of temporaryDirectories.splice(0)) run(["rm", "-rf", path]);
});

describe("server coverage aggregation", () => {
  it("merges shard reports before enforcing repository thresholds", () => {
    const input = makeInput();
    const output = `${input}/merged.json`;
    const sourcePath = "/workspace/apps/server/src/example.ts";
    writeJson(
      `${input}/shard-1/coverage-final.json`,
      coverageFor(sourcePath, { branches: [1, 0], functions: 1, statements: 1 })
    );
    writeJson(
      `${input}/shard-2/coverage-final.json`,
      coverageFor(sourcePath, { branches: [0, 1], functions: 0, statements: 0 })
    );

    const result = runMerge(input, output);

    expect(result.exitCode).toBe(0);
    expect(decode(result.stdout)).toContain("branches: 100%");
    const merged = run(["cat", output]);
    expect(JSON.parse(decode(merged.stdout))).toHaveProperty([sourcePath]);
  });

  it("rejects merged coverage below any 90 percent threshold", () => {
    const input = makeInput();
    const output = `${input}/merged.json`;
    const sourcePath = "/workspace/apps/server/src/example.ts";
    writeJson(
      `${input}/shard-1/coverage-final.json`,
      coverageFor(sourcePath, { branches: [1, 0], functions: 1, statements: 1 })
    );
    writeJson(`${input}/shard-2/coverage-final.json`, {});

    const result = runMerge(input, output);

    expect(result.exitCode).toBe(1);
    expect(decode(result.stderr)).toContain("branches coverage 50% is below 90%");
  });
});
