import { it } from "@effect/vitest";
import { Data, Effect } from "effect";
import { afterEach, expect } from "vitest";

class FixtureUnavailable extends Data.TaggedError("FixtureUnavailable") {}

const writeFixture = (path: string, contents: string): Effect.Effect<number, FixtureUnavailable> =>
  Effect.tryPromise({
    try: () => Bun.write(path, contents),
    catch: () => new FixtureUnavailable(),
  });

const fixtures: string[] = [];
afterEach(() => {
  for (const fixture of fixtures.splice(0)) Bun.spawnSync(["rm", "-rf", fixture]);
});

const fixture = Effect.fnUntraced(function* () {
  const temporary = Bun.spawnSync(["mktemp", "-d"]);
  if (temporary.exitCode !== 0) return yield* new FixtureUnavailable();
  const root = new TextDecoder().decode(temporary.stdout).trim();
  fixtures.push(root);
  const git = (...args: string[]): string => {
    const result = Bun.spawnSync(["git", ...args], { cwd: root });
    if (result.exitCode !== 0) throw new Error(new TextDecoder().decode(result.stderr));
    return new TextDecoder().decode(result.stdout).trim();
  };
  git("init", "-b", "trunk");
  git("config", "user.name", "Hook fixture");
  git("config", "user.email", "fixture@example.invalid");
  git("config", "commit.gpgsign", "false");
  const commit = Effect.fnUntraced(function* (file: string, contents: string) {
    yield* writeFixture(`${root}/${file}`, contents);
    git("add", file);
    git("commit", "-m", "fixture");
    return git("rev-parse", "HEAD");
  });
  const base = yield* commit("base.txt", "base\n");
  const bin = `${root}/bin`;
  yield* writeFixture(
    `${bin}/gitleaks`,
    `#!/usr/bin/env bash
set -euo pipefail
for argument in "$@"; do
  if [[ "$argument" == --log-opts=* ]]; then
    read -r -a options <<< "\${argument#--log-opts=}"
    patch=$(git log -p "\${options[@]}")
    if [[ "$patch" == *"+scan-fixture-marker"* ]]; then exit 1; fi
    exit 0
  fi
done
exit 2
`
  );
  yield* writeFixture(`${bin}/trufflehog`, "#!/usr/bin/env bash\nexit 0\n");
  Bun.spawnSync(["chmod", "+x", `${bin}/gitleaks`, `${bin}/trufflehog`]);
  const scan = (input?: string): Bun.SyncSubprocess =>
    Bun.spawnSync(
      [process.execPath, new URL("./check-pushed-secrets.ts", import.meta.url).pathname],
      {
        cwd: root,
        env: { ...Bun.env, PATH: `${bin}:${Bun.env.PATH}` },
        stdin: new TextEncoder().encode(
          input ?? `refs/heads/trunk ${git("rev-parse", "HEAD")} refs/heads/trunk ${base}\n`
        ),
      }
    );
  return { git, commit, scan };
});

it.effect("rejects a marker committed and removed on a merged side branch", () =>
  Effect.gen(function* () {
    const { git, commit, scan } = yield* fixture();
    git("checkout", "-b", "side");
    yield* commit("side.txt", "scan-fixture-marker\n");
    yield* commit("side.txt", "clean\n");
    git("checkout", "trunk");
    yield* commit("trunk.txt", "clean\n");
    git("merge", "--no-ff", "side", "-m", "merge");
    const result = scan();
    expect(new TextDecoder().decode(result.stderr)).toBe("");
    expect(result.exitCode).toBe(1);
  })
);

it.effect("rejects a marker introduced only in the merge commit", () =>
  Effect.gen(function* () {
    const { git, commit, scan } = yield* fixture();
    git("checkout", "-b", "side");
    yield* commit("side.txt", "clean\n");
    git("checkout", "trunk");
    yield* commit("trunk.txt", "clean\n");
    git("merge", "--no-ff", "--no-commit", "side");
    yield* commit("merge.txt", "scan-fixture-marker\n");
    const result = scan();
    expect(new TextDecoder().decode(result.stderr)).toBe("");
    expect(result.exitCode).toBe(1);
  })
);

it.effect("accepts a clean pushed history", () =>
  Effect.gen(function* () {
    const { commit, scan } = yield* fixture();
    yield* commit("clean.txt", "clean\n");
    const result = scan();
    expect(new TextDecoder().decode(result.stderr)).toBe("");
    expect(result.exitCode).toBe(0);
  })
);

it.effect("skips scans for a deletion-only push without requiring a local comparison branch", () =>
  Effect.gen(function* () {
    const { commit, scan } = yield* fixture();
    const head = yield* commit("local.txt", "scan-fixture-marker\n");
    const result = scan(`(delete) ${"0".repeat(40)} refs/heads/obsolete ${head}\n`);
    expect(new TextDecoder().decode(result.stderr)).toBe("");
    expect(result.exitCode).toBe(0);
  })
);
