import { BunFileSystem } from "@effect/platform-bun";
import { layer } from "@effect/vitest";
import { Effect, FileSystem } from "effect";
import { expect } from "vitest";

const workspaceRoot = new URL("../../", import.meta.url).pathname;

const policyFixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "edge-policy-" });
  yield* fs.makeDirectory(`${root}/infra`, { recursive: true });
  yield* fs.copy(`${workspaceRoot}infra/cloudflare`, `${root}/infra/cloudflare`);
  yield* fs.copy(`${workspaceRoot}patches`, `${root}/patches`);
  yield* fs.makeDirectory(`${root}/scripts/infra-performance`, { recursive: true });
  yield* fs.copy(`${workspaceRoot}scripts/pro`, `${root}/scripts/pro`);
  yield* fs.copy(`${workspaceRoot}scripts/retirement`, `${root}/scripts/retirement`);
  for (const owner of ["deployed-fleet", "canonical-fixture", "cells", "hosted-browser"]) {
    const directory = `scripts/infra-performance/${owner}`;
    yield* fs.copy(`${workspaceRoot}${directory}`, `${root}/${directory}`);
  }
  yield* fs.copy(
    `${workspaceRoot}scripts/infra-performance/d1-budget.ts`,
    `${root}/scripts/infra-performance/d1-budget.ts`
  );
  for (const name of [".github", "apps", "node_modules", "tsconfig.base.json"]) {
    yield* fs.symlink(`${workspaceRoot}${name}`, `${root}/${name}`);
  }
  return `${root}/infra/cloudflare`;
});

const runPolicyGate = (directory: string): Bun.SyncSubprocess<"pipe", "pipe"> =>
  Bun.spawnSync([process.execPath, `${directory}/verify-edge-policy.ts`], {
    cwd: directory,
    stdout: "pipe",
    stderr: "pipe",
  });

layer(BunFileSystem.layer, { excludeTestServices: true })(
  "mandatory edge policy verification",
  (it) => {
    it.effect(
      "accepts the reviewed policy through the Production CLI",
      () =>
        Effect.gen(function* () {
          const directory = yield* policyFixture;
          const result = yield* Effect.sync(() => runPolicyGate(directory));
          expect(result.exitCode).toBe(0);
          expect(new TextDecoder().decode(result.stdout)).toBe("");
          expect(new TextDecoder().decode(result.stderr)).toBe("");
        }),
      20_000
    );

    it.effect.each([
      "worker-observability.ts",
      "../../scripts/pro/runtime.ts",
      "../../scripts/retirement/provider.py",
    ])(
      "refuses changes in %s without disclosing their contents",
      (source) =>
        Effect.gen(function* () {
          const directory = yield* policyFixture;
          const fs = yield* FileSystem.FileSystem;
          const artifact = `${directory}/${source}`;
          const original = yield* fs.readFileString(artifact);
          yield* fs.writeFileString(artifact, `${original}\n// private-policy-change\n`);
          const result = yield* Effect.sync(() => runPolicyGate(directory));
          expect(result.exitCode).toBe(1);
          expect(new TextDecoder().decode(result.stdout)).toBe("");
          expect(new TextDecoder().decode(result.stderr)).toBe(
            "Desired edge policy differs from the reviewed manifest.\n"
          );
        }),
      20_000
    );
  }
);
