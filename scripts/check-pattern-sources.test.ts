import { afterEach, expect } from "vitest";
import { it } from "@effect/vitest";
import { Effect, Schema } from "effect";

const FixturePaths = Schema.Record(
  Schema.String,
  Schema.Struct({
    snapshot: Schema.Struct({ manifest: Schema.String }),
    packages: Schema.Array(Schema.Struct({ manifest: Schema.String })),
    sourcePaths: Schema.Array(Schema.String),
    patches: Schema.Array(Schema.Struct({ path: Schema.String })),
  })
);

const repositoryRoot = Bun.fileURLToPath(new URL("..", import.meta.url));
const temporaryRoots: Array<string> = [];
afterEach(() => {
  for (const root of temporaryRoots.splice(0)) Bun.spawnSync(["rm", "-rf", root]);
});

const write = (path: string, content: string): Effect.Effect<number> =>
  Effect.tryPromise(() => Bun.write(path, content)).pipe(Effect.orDie);

const fixture = Effect.gen(function* () {
  const sourceText = yield* Effect.tryPromise(() =>
    Bun.file(`${repositoryRoot}/.patterns/sources.json`).text()
  ).pipe(Effect.orDie);
  const sources = yield* Schema.decodeEffect(Schema.fromJsonString(FixturePaths))(sourceText);
  const temporary = Bun.spawnSync(["mktemp", "-d"]);
  expect(temporary.exitCode).toBe(0);
  const root = new TextDecoder().decode(temporary.stdout).trim();
  temporaryRoots.push(root);
  const paths = new Set([
    "package.json",
    ".patterns/sources.json",
    ...Object.values(sources).flatMap((source) => [
      source.snapshot.manifest,
      ...source.packages.map((pin) => pin.manifest),
      ...source.sourcePaths,
      ...source.patches.map((patch) => patch.path),
    ]),
  ]);
  for (const path of paths) {
    const content = yield* Effect.tryPromise(() =>
      Bun.file(`${repositoryRoot}/${path}`).text()
    ).pipe(Effect.orDie);
    yield* write(`${root}/${path}`, content);
  }
  yield* write(`${root}/.patterns/INDEX.md`, "[HTTP](http.md)\n");
  yield* write(`${root}/.patterns/http.md`, "# HTTP\n");
  return root;
});

const run = (root: string): Readonly<{ status: number; stderr: string }> => {
  const result = Bun.spawnSync([
    process.execPath,
    `${repositoryRoot}/scripts/check-pattern-sources.ts`,
    "--root",
    root,
  ]);
  return { status: result.exitCode, stderr: new TextDecoder().decode(result.stderr) };
};

it.effect("accepts explicitly historical snapshots with different application versions", () =>
  Effect.gen(function* () {
    expect(run(yield* fixture)).toEqual({ status: 0, stderr: "" });
  })
);

it.effect("requires a pattern review when an application pin changes", () =>
  Effect.gen(function* () {
    const root = yield* fixture;
    yield* write(`${root}/apps/web/package.json`, '{"dependencies":{"react":"19.4.0"}}');
    const result = run(root);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("react: react changed from 19.3.1 to 19.4.0");
  })
);

it.effect("rejects a refreshed snapshot whose recorded version has not been reviewed", () =>
  Effect.gen(function* () {
    const root = yield* fixture;
    yield* write(`${root}/.repos/react/packages/react/package.json`, '{"version":"19.3.0"}');
    const result = run(root);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("react: snapshot version changed");
  })
);

it.effect("detects changed selected patch content even when the package version stays fixed", () =>
  Effect.gen(function* () {
    const root = yield* fixture;
    yield* write(`${root}/patches/alchemy@2.0.0-beta.80.patch`, "changed provider behavior\n");
    const result = run(root);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("alchemy: patch content changed");
  })
);

it.effect("reports undiscoverable patterns and broken local references", () =>
  Effect.gen(function* () {
    const root = yield* fixture;
    yield* write(`${root}/.patterns/new-topic.md`, "[Recipe](missing.md#recipe)\n");
    const result = run(root);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("new-topic.md: missing INDEX.md entry");
    expect(result.stderr).toContain("new-topic.md: broken local link missing.md");
  })
);

it.effect("reports a removed source file independently of package versions", () =>
  Effect.gen(function* () {
    const root = yield* fixture;
    Bun.spawnSync(["rm", `${root}/.repos/effect/packages/effect/src/Effect.ts`]);
    const result = run(root);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("effect: missing source path");
  })
);
