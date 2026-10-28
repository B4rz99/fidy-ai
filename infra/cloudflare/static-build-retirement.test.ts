import { AlchemyContext } from "alchemy/AlchemyContext";
import { hashDirectory } from "alchemy/Command/Memo";
import { it } from "@effect/vitest";
import { expect } from "vitest";
import { BunServices } from "@effect/platform-bun";
import { Effect, FileSystem } from "effect";

it.effect("keeps the verified site build input unchanged after public browser probes", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "site-retirement-" });
    const cwd = `${root}/apps/site`;
    yield* fs.makeDirectory(`${cwd}/src`, { recursive: true });
    yield* fs.writeFileString(`${root}/.git`, "fixture");
    yield* fs.writeFileString(`${root}/bun.lock`, "fixture lock");
    yield* fs.copyFile(new URL("../../.gitignore", import.meta.url).pathname, `${root}/.gitignore`);
    yield* fs.writeFileString(`${cwd}/src/index.ts`, "export const revision = 1;");
    const ignorePath = new URL("../../apps/site/.gitignore", import.meta.url).pathname;
    yield* fs.copyFile(ignorePath, `${cwd}/.gitignore`);

    const hashInput = hashDirectory({ cwd }).pipe(
      Effect.provideService(AlchemyContext, { dotAlchemy: root, dev: false, adopt: false })
    );
    const beforeProbes = yield* hashInput;

    for (const directory of ["test-results", "playwright-report", ".astro"]) {
      yield* fs.makeDirectory(`${cwd}/${directory}`, { recursive: true });
      yield* fs.writeFileString(`${cwd}/${directory}/generated.json`, '{"status":"passed"}');
    }
    expect(yield* hashInput).toBe(beforeProbes);
    yield* fs.writeFileString(`${cwd}/src/index.ts`, "export const revision = 2;");
    expect(yield* hashInput).not.toBe(beforeProbes);
    const beforeLockChange = yield* hashInput;
    yield* fs.writeFileString(`${root}/bun.lock`, "updated lock");
    expect(yield* hashInput).not.toBe(beforeLockChange);
  }).pipe(Effect.provide(BunServices.layer), Effect.scoped)
);
