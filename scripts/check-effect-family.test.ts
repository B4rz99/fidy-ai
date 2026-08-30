import { Option } from "effect";
import { afterEach, expect, it } from "vitest";

const repositoryRoot = process.cwd();
const checkScript = `${repositoryRoot}/scripts/check-effect-family.ts`;
const temporaryRoots: Array<string> = [];
let fixtureSequence = 0;

type CommandResult = Readonly<{
  exitCode: number;
  stdout: Uint8Array;
  stderr: Uint8Array;
}>;

const decode = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);
const run = (command: ReadonlyArray<string>): CommandResult => {
  const result = Bun.spawnSync([...command], { stdout: "pipe", stderr: "pipe" });
  return {
    exitCode: result.exitCode,
    stdout: Option.getOrElse(Option.fromUndefinedOr(result.stdout), () => new Uint8Array()),
    stderr: Option.getOrElse(Option.fromUndefinedOr(result.stderr), () => new Uint8Array()),
  };
};

type EffectFixture = {
  readonly platformVersion: string;
  readonly effectVersion: string;
  readonly transitiveVersion: string;
  readonly overrideVersion: string;
  readonly aiVersion: string;
  readonly qualifiedEffectVersion: string;
};

const qualifiedPackage = (
  version: Option.Option<string>
): Readonly<Record<string, ReadonlyArray<string>>> =>
  Option.match(version, {
    onNone: () => ({}),
    onSome: (selected) => ({ [`effect@${selected}`]: [`effect@${selected}`, ""] }),
  });

const makeFixture = (overrides: Partial<EffectFixture> = {}): string => {
  fixtureSequence += 1;
  const root = `${Bun.env.TMPDIR ?? "/tmp"}/fidy-effect-family-${process.pid}-${fixtureSequence}`;
  const effectVersion = overrides.effectVersion ?? "4.0.0-beta.98";
  const platformVersion = overrides.platformVersion ?? effectVersion;
  const transitiveVersion = overrides.transitiveVersion ?? effectVersion;
  const overrideVersion = overrides.overrideVersion ?? effectVersion;
  const aiVersion = overrides.aiVersion ?? effectVersion;
  const packageJson = {
    name: "fixture",
    version: "0.0.0",
    private: true,
    dependencies: {
      effect: effectVersion,
      "@effect/ai": aiVersion,
      "@effect/platform-bun": platformVersion,
    },
    overrides: { "@effect/platform-node-shared": overrideVersion },
  };
  const lockfile = {
    lockfileVersion: 1,
    configVersion: 1,
    workspaces: {
      "": {
        name: "fixture",
        dependencies: packageJson.dependencies,
      },
    },
    packages: {
      effect: [`effect@${effectVersion}`, ""],
      "@effect/ai": [`@effect/ai@${aiVersion}`, ""],
      "@effect/platform-bun": [`@effect/platform-bun@${platformVersion}`, ""],
      "@effect/platform-node-shared": [`@effect/platform-node-shared@${transitiveVersion}`, ""],
      ...qualifiedPackage(Option.fromUndefinedOr(overrides.qualifiedEffectVersion)),
    },
  };

  run(["mkdir", "-p", root]);
  run([
    "sh",
    "-c",
    `printf %s "$1" > "$2"`,
    "write-fixture",
    JSON.stringify(packageJson),
    `${root}/package.json`,
  ]);
  run([
    "sh",
    "-c",
    `printf %s "$1" > "$2"`,
    "write-fixture",
    JSON.stringify(lockfile),
    `${root}/bun.lock`,
  ]);
  temporaryRoots.push(root);
  return root;
};

const checkFixture = (root: string): CommandResult => run(["bun", checkScript, "--root", root]);

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) run(["rm", "-rf", root]);
});

it("accepts direct and transitive Effect packages from one selected v4 beta family", () => {
  const result = checkFixture(makeFixture({}));

  expect(result.exitCode).toBe(0);
  expect(decode(result.stdout)).toContain("Effect dependency family: 4.0.0-beta.98");
});

it("reports a directly selected Effect package from another release channel", () => {
  const result = checkFixture(makeFixture({ platformVersion: "3.19.4" }));

  expect(result.exitCode).toBe(1);
  expect(decode(result.stderr)).toContain("@effect/platform-bun: 3.19.4");
});

it("reports a directly selected base package from an unrelated release channel", () => {
  const result = checkFixture(makeFixture({ aiVersion: "0.16.0" }));

  expect(result.exitCode).toBe(1);
  expect(decode(result.stderr)).toContain("@effect/ai: 0.16.0");
});

it("reports a version-qualified duplicate Effect runtime", () => {
  const result = checkFixture(makeFixture({ qualifiedEffectVersion: "3.19.4" }));

  expect(result.exitCode).toBe(1);
  expect(decode(result.stderr)).toContain("effect: 3.19.4");
});

it("reports a transitive platform package that advanced beyond the selected beta", () => {
  const result = checkFixture(makeFixture({ transitiveVersion: "4.0.0-beta.105" }));

  expect(result.exitCode).toBe(1);
  expect(decode(result.stderr)).toContain("@effect/platform-node-shared: 4.0.0-beta.105");
});

it("requires transitive platform overrides to pin the selected beta exactly", () => {
  const result = checkFixture(makeFixture({ overrideVersion: "^4.0.0-beta.98" }));

  expect(result.exitCode).toBe(1);
  expect(decode(result.stderr)).toContain("@effect/platform-node-shared override: ^4.0.0-beta.98");
});
