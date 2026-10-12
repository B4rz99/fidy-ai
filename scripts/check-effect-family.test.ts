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
  readonly sqlVersion: string;
  readonly vitestVersion: string;
  readonly atomReactVersion: string;
  readonly qualifiedEffectVersion: string;
  readonly includeOverride: boolean;
  readonly extraOverrides: Readonly<Record<string, string>>;
  readonly lockedOverrides: Readonly<Record<string, string | Readonly<Record<string, string>>>>;
  readonly lockedWorkspaceVersion: string;
};

const qualifiedPackage = (
  version: Option.Option<string>
): Readonly<Record<string, ReadonlyArray<string>>> =>
  Option.match(version, {
    onNone: () => ({}),
    onSome: (selected) => ({ [`effect@${selected}`]: [`effect@${selected}`, ""] }),
  });

const versionOr = (version: Option.Option<string>, fallback: string): string =>
  Option.getOrElse(version, () => fallback);

const makeFixture = (overrides: Partial<EffectFixture> = {}): string => {
  fixtureSequence += 1;
  const root = `${Bun.env.TMPDIR ?? "/tmp"}/fidy-effect-family-${process.pid}-${fixtureSequence}`;
  const effectVersion = versionOr(Option.fromUndefinedOr(overrides.effectVersion), "4.0.0-beta.98");
  const platformVersion = versionOr(
    Option.fromUndefinedOr(overrides.platformVersion),
    effectVersion
  );
  const transitiveVersion = versionOr(
    Option.fromUndefinedOr(overrides.transitiveVersion),
    effectVersion
  );
  const overrideVersion = versionOr(
    Option.fromUndefinedOr(overrides.overrideVersion),
    effectVersion
  );
  const aiVersion = versionOr(Option.fromUndefinedOr(overrides.aiVersion), effectVersion);
  const sqlVersion = versionOr(Option.fromUndefinedOr(overrides.sqlVersion), effectVersion);
  const vitestVersion = versionOr(Option.fromUndefinedOr(overrides.vitestVersion), effectVersion);
  const atomReactVersion = versionOr(
    Option.fromUndefinedOr(overrides.atomReactVersion),
    effectVersion
  );
  const includeOverride = Option.getOrElse(
    Option.fromUndefinedOr(overrides.includeOverride),
    () => true
  );
  const packageJson = {
    name: "fixture",
    version: "0.0.0",
    private: true,
    dependencies: {
      effect: effectVersion,
      "@effect/ai": aiVersion,
      "@effect/platform-cloudflare": platformVersion,
      "@effect/sql-d1": sqlVersion,
      "@effect/atom-react": atomReactVersion,
    },
    devDependencies: { "@effect/vitest": vitestVersion },
    overrides: {
      ...(includeOverride ? { "@effect/platform-shared": overrideVersion } : {}),
      ...overrides.extraOverrides,
    },
  };
  const lockfile = {
    lockfileVersion: 1,
    configVersion: 1,
    workspaces: {
      "": {
        name: "fixture",
        dependencies: {
          ...packageJson.dependencies,
          effect: overrides.lockedWorkspaceVersion ?? effectVersion,
        },
        devDependencies: packageJson.devDependencies,
      },
    },
    overrides: overrides.lockedOverrides ?? packageJson.overrides,
    packages: {
      effect: [`effect@${effectVersion}`, ""],
      "@effect/ai": [`@effect/ai@${aiVersion}`, ""],
      "@effect/platform-cloudflare": [`@effect/platform-cloudflare@${platformVersion}`, ""],
      "@effect/platform-shared": [`@effect/platform-shared@${transitiveVersion}`, ""],
      "@effect/sql-d1": [`@effect/sql-d1@${sqlVersion}`, ""],
      "@effect/vitest": [`@effect/vitest@${vitestVersion}`, ""],
      "@effect/atom-react": [`@effect/atom-react@${atomReactVersion}`, ""],
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

it("accepts direct and transitive Effect packages from one selected v4 RC family", () => {
  const result = checkFixture(makeFixture({ effectVersion: "4.0.0-rc.3" }));

  expect(result.exitCode).toBe(0);
  expect(decode(result.stdout)).toContain("Effect dependency family: 4.0.0-rc.3");
});

it("accepts an exact stable v4 family without changing the installed repository family", () => {
  const result = checkFixture(makeFixture({ effectVersion: "4.0.0" }));

  expect(result.exitCode).toBe(0);
  expect(decode(result.stdout)).toContain("Effect dependency family: 4.0.0");
});

it("reports the manifest location when the selected Effect runtime is not an exact v4 family", () => {
  const root = makeFixture({ effectVersion: "3.19.4" });
  const result = checkFixture(root);

  expect(result.exitCode).toBe(1);
  expect(decode(result.stderr)).toContain(`effect: 3.19.4 (${root}/package.json)`);
});

it.each(["^4.0.0", "4.0.0-rc.115", "4.0.1", "3.22.2"])(
  "rejects %s mixed into the selected stable family",
  (platformVersion) => {
    const result = checkFixture(makeFixture({ effectVersion: "4.0.0", platformVersion }));

    expect(result.exitCode).toBe(1);
    expect(decode(result.stderr)).toContain(`@effect/platform-cloudflare: ${platformVersion}`);
  }
);

it("reports a stale Effect version in the lockfile workspace declaration", () => {
  const result = checkFixture(
    makeFixture({ effectVersion: "4.0.0", lockedWorkspaceVersion: "4.0.0-rc.115" })
  );

  expect(result.exitCode).toBe(1);
  expect(decode(result.stderr)).toContain("effect: 4.0.0-rc.115 (bun.lock workspace .)");
});

it("reports a beta package mixed into the selected RC family", () => {
  const result = checkFixture(
    makeFixture({ effectVersion: "4.0.0-rc.3", platformVersion: "4.0.0-beta.98" })
  );

  expect(result.exitCode).toBe(1);
  expect(decode(result.stderr)).toContain("@effect/platform-cloudflare: 4.0.0-beta.98");
});

it("reports an Effect package from a different RC family", () => {
  const result = checkFixture(
    makeFixture({ effectVersion: "4.0.0-rc.3", sqlVersion: "4.0.0-rc.4" })
  );

  expect(result.exitCode).toBe(1);
  expect(decode(result.stderr)).toContain("@effect/sql-d1: 4.0.0-rc.4");
});

it("reports a directly selected Effect package from another release channel", () => {
  const result = checkFixture(makeFixture({ platformVersion: "3.19.4" }));

  expect(result.exitCode).toBe(1);
  expect(decode(result.stderr)).toContain("@effect/platform-cloudflare: 3.19.4");
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
  expect(decode(result.stderr)).toContain("@effect/platform-shared: 4.0.0-beta.105");
});

it("requires transitive platform overrides to pin the selected beta exactly", () => {
  const result = checkFixture(makeFixture({ overrideVersion: "^4.0.0-beta.98" }));

  expect(result.exitCode).toBe(1);
  expect(decode(result.stderr)).toContain("@effect/platform-shared override: ^4.0.0-beta.98");
});

it.each(["effect", "@effect/sql-d1", "@effect/sql-d1@^4.0.0"])(
  "rejects a conflicting %s override even when resolved packages still agree",
  (packageName) => {
    const result = checkFixture(
      makeFixture({
        effectVersion: "4.0.0",
        extraOverrides: { [packageName]: "4.0.0-rc.115" },
      })
    );

    expect(result.exitCode).toBe(1);
    expect(decode(result.stderr)).toContain(`${packageName} override: 4.0.0-rc.115 (`);
  }
);

it("accepts Bun's qualified override objects without ignoring a conflicting family selection", () => {
  const accepted = checkFixture(
    makeFixture({
      effectVersion: "4.0.0",
      lockedOverrides: {
        "@effect/platform-shared": "4.0.0",
        "undici@^7": { ".": "7.29.1" },
        "@effect/sql-d1@^4.0.0": { ".": "4.0.0" },
      },
    })
  );
  expect(accepted.exitCode).toBe(0);

  const rejected = checkFixture(
    makeFixture({
      effectVersion: "4.0.0",
      lockedOverrides: { "@effect/sql-d1@^4.0.0": { ".": "4.0.0-rc.115" } },
    })
  );
  expect(rejected.exitCode).toBe(1);
  expect(decode(rejected.stderr)).toContain(
    "@effect/sql-d1@^4.0.0 override: 4.0.0-rc.115 (bun.lock overrides)"
  );
});

it("reports a stale override retained only in the lockfile", () => {
  const result = checkFixture(
    makeFixture({
      effectVersion: "4.0.0",
      lockedOverrides: { "@effect/platform-shared": "4.0.0-rc.115" },
    })
  );

  expect(result.exitCode).toBe(1);
  expect(decode(result.stderr)).toContain(
    "@effect/platform-shared override: 4.0.0-rc.115 (bun.lock overrides)"
  );
});

it("reports a missing transitive platform override with its manifest location", () => {
  const result = checkFixture(makeFixture({ includeOverride: false }));

  expect(result.exitCode).toBe(1);
  expect(decode(result.stderr)).toContain(
    "@effect/platform-shared override: missing (package.json)"
  );
});
