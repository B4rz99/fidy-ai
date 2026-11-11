import { expect } from "vitest";
import { it } from "@effect/vitest";
import { Effect } from "effect";
import { partitionSourceFiles, sourceScanPlan } from "./partition-source-scan";

it("balances the complete source scope without duplication, omissions, or input-order dependence", () => {
  const files = [
    { path: "large.ts", bytes: 60 },
    { path: "medium.ts", bytes: 40 },
    { path: "small.ts", bytes: 30 },
    { path: "tiny.ts", bytes: 20 },
    { path: "header.txt", bytes: 0 },
    { path: "other.ts", bytes: 10 },
  ];
  const parts = partitionSourceFiles({ files, count: 3 });
  expect(parts).toEqual(partitionSourceFiles({ files: files.toReversed(), count: 3 }));
  expect(parts.flat().toSorted()).toEqual(files.map(({ path }) => path).toSorted());
  expect(new Set(parts.flat()).size).toBe(files.length);
  const bytes = new Map(files.map(({ path, bytes }) => [path, bytes]));
  expect(
    Math.max(...parts.map((part) => part.reduce((sum, path) => sum + (bytes.get(path) ?? 0), 0)))
  ).toBe(60);
});

it("refuses invalid partition counts and duplicated source targets", () => {
  const files = [{ path: "source.ts", bytes: 10 }];
  for (const count of [0, -1, 1.5]) expect(() => partitionSourceFiles({ files, count })).toThrow();
  expect(() => partitionSourceFiles({ files: [...files, ...files], count: 3 })).toThrow(
    "Duplicate"
  );
});

it("keeps every partition on an already selected runner for every change plan", () => {
  for (const native of [false, true]) {
    for (const sca of [false, true]) {
      const plan = sourceScanPlan({ native, sca });
      const indices = [1, ...(native ? [2] : []), ...(sca ? [plan.sca] : [])];
      expect(indices).toEqual(Array.from({ length: plan.count }, (_, index) => index + 1));
    }
  }
});

it.effect(
  "scans the complete source on one selected runner and refuses obsolete four-runner plans",
  () =>
    Effect.gen(function* () {
      const temporary = Bun.spawnSync(["mktemp", "-d", "/tmp/fidy-source-plan.XXXXXX"]);
      expect(temporary.exitCode).toBe(0);
      const directory = new TextDecoder().decode(temporary.stdout).trim();
      const script = Bun.fileURLToPath(new URL("./partition-source-scan.ts", import.meta.url));
      try {
        expect(Bun.spawnSync(["mkdir", "-p", `${directory}/.fluidattacks`]).exitCode).toBe(0);
        yield* Effect.tryPromise(() =>
          Bun.write(
            `${directory}/.fluidattacks/sast.yaml`,
            "sast:\n  include: ['.']\n  exclude: []\n  multifile: false\n"
          )
        );
        yield* Effect.tryPromise(() =>
          Bun.write(`${directory}/source.ts`, "export const value = 1;\n")
        );
        expect(Bun.spawnSync(["git", "init", "--quiet"], { cwd: directory }).exitCode).toBe(0);
        expect(Bun.spawnSync(["git", "add", "."], { cwd: directory }).exitCode).toBe(0);
        const output = `${directory}/scan.yaml`;
        const run = (selection: string): Bun.SyncSubprocess =>
          Bun.spawnSync([process.execPath, script, selection, output], { cwd: directory });
        expect(run("1/1").exitCode).toBe(0);
        const source = yield* Effect.tryPromise(() => Bun.file(output).text());
        expect(Bun.YAML.parse(source)).toMatchObject({
          sast: { include: [".fluidattacks/sast.yaml", "source.ts"], multifile: false },
        });
        expect(run("4/4").exitCode).not.toBe(0);
      } finally {
        Bun.spawnSync(["rm", "-rf", directory]);
      }
    })
);
