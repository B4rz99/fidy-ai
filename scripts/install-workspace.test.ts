import { afterEach, expect } from "vitest";
import { it } from "@effect/vitest";
import { Data, Effect } from "effect";

class FixtureUnavailable extends Data.TaggedError("FixtureUnavailable") {}

const fixtures: Array<string> = [];
afterEach(() => {
  for (const fixture of fixtures.splice(0)) Bun.spawnSync(["rm", "-rf", fixture]);
});

const installer = await Bun.file(new URL("./install-workspace.sh", import.meta.url)).text();
const authorizedLock = await Bun.file(new URL("../bun.lock", import.meta.url)).text();

const runInstaller = Effect.fnUntraced(function* (
  lock: string,
  day: string,
  args: ReadonlyArray<string> = []
) {
  const temporary = Bun.spawnSync(["mktemp", "-d"]);
  if (temporary.exitCode !== 0) return yield* new FixtureUnavailable();
  const root = new TextDecoder().decode(temporary.stdout).trim();
  fixtures.push(root);
  yield* Effect.tryPromise({
    try: () => Bun.write(`${root}/scripts/install-workspace.sh`, installer),
    catch: () => new FixtureUnavailable(),
  });
  yield* Effect.tryPromise({
    try: () => Bun.write(`${root}/bun.lock`, lock),
    catch: () => new FixtureUnavailable(),
  });
  yield* Effect.tryPromise({
    try: () => Bun.write(`${root}/bin/bun`, '#!/usr/bin/env bash\nprintf "%s\\n" "$@"\n'),
    catch: () => new FixtureUnavailable(),
  });
  yield* Effect.tryPromise({
    try: () => Bun.write(`${root}/bin/date`, `#!/usr/bin/env bash\nprintf '%s\\n' '${day}'\n`),
    catch: () => new FixtureUnavailable(),
  });
  Bun.spawnSync(["chmod", "+x", `${root}/bin/bun`, `${root}/bin/date`]);
  return Bun.spawnSync(["bash", `${root}/scripts/install-workspace.sh`, ...args], {
    env: { ...Bun.env, PATH: `${root}/bin:${Bun.env.PATH}` },
  });
});

it.effect(
  "admits only the authorized frozen snapshot before expiry and preserves script suppression",
  () =>
    Effect.gen(function* () {
      const result = yield* runInstaller(authorizedLock, "2026-10-09", ["--ignore-scripts"]);
      expect(result.exitCode).toBe(0);
      expect(new TextDecoder().decode(result.stdout)).toBe(
        "install\n--frozen-lockfile\n--minimum-release-age=0\n--ignore-scripts\n"
      );
    })
);

it.effect("uses the ordinary cooldown for a changed dependency snapshot", () =>
  Effect.gen(function* () {
    const result = yield* runInstaller(`${authorizedLock}\n`, "2026-10-09");
    expect(result.exitCode).toBe(0);
    expect(new TextDecoder().decode(result.stdout)).toBe("install\n--frozen-lockfile\n");
  })
);

it.effect("returns to the ordinary cooldown at the exception deadline", () =>
  Effect.gen(function* () {
    const result = yield* runInstaller(authorizedLock, "2026-10-10");
    expect(result.exitCode).toBe(0);
    expect(new TextDecoder().decode(result.stdout)).toBe("install\n--frozen-lockfile\n");
  })
);

it.effect("refuses arguments that could change the admitted install graph", () =>
  Effect.gen(function* () {
    const result = yield* runInstaller(authorizedLock, "2026-10-09", ["--no-save"]);
    expect(result.exitCode).toBe(2);
    expect(new TextDecoder().decode(result.stdout)).toBe("");
  })
);
