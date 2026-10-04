import { afterEach, expect } from "vitest";
import { it } from "@effect/vitest";
import { Data, Effect } from "effect";

class FixtureUnavailable extends Data.TaggedError("FixtureUnavailable") {}

const fixtures: Array<string> = [];
afterEach(() => {
  for (const fixture of fixtures.splice(0)) Bun.spawnSync(["rm", "-rf", fixture]);
});

it.effect(
  "runs shared browser checks and an explicitly isolated CLI journey in the browser gate",
  () =>
    Effect.gen(function* () {
      const temporary = Bun.spawnSync(["mktemp", "-d"]);
      expect(temporary.exitCode).toBe(0);
      const directory = new TextDecoder().decode(temporary.stdout).trim();
      fixtures.push(directory);
      yield* Effect.tryPromise({
        try: () =>
          Bun.write(
            `${directory}/bun`,
            '#!/usr/bin/env bash\nprintf "CHECK mode=%s args=" "${CLI_ACCEPTANCE_MODE:-shared}"\nprintf "%s " "$@"\nprintf "\\n"\nif [[ "${FAIL_CLI_JOURNEY:-0}" == 1 && "${CLI_ACCEPTANCE_MODE:-shared}" == cli ]]; then exit 1; fi\n'
          ),
        catch: () => new FixtureUnavailable(),
      });
      expect(Bun.spawnSync(["chmod", "+x", `${directory}/bun`]).exitCode).toBe(0);
      const result = Bun.spawnSync(
        [
          process.execPath,
          Bun.fileURLToPath(new URL("./verify.ts", import.meta.url)),
          "--group",
          "browser",
        ],
        {
          env: { ...Bun.env, CLI_ACCEPTANCE_MODE: undefined, PATH: `${directory}:${Bun.env.PATH}` },
        }
      );
      expect(result.exitCode).toBe(0);
      expect(
        new TextDecoder()
          .decode(result.stdout)
          .split("\n")
          .filter((line) => line.startsWith("CHECK "))
      ).toEqual([
        "CHECK mode=shared args=run --cwd apps/web test:browser ",
        "CHECK mode=cli args=run --cwd apps/web test:browser:cli ",
      ]);
      const failed = Bun.spawnSync(
        [
          process.execPath,
          Bun.fileURLToPath(new URL("./verify.ts", import.meta.url)),
          "--group",
          "browser",
        ],
        {
          env: {
            ...Bun.env,
            CLI_ACCEPTANCE_MODE: undefined,
            FAIL_CLI_JOURNEY: "1",
            PATH: `${directory}:${Bun.env.PATH}`,
          },
        }
      );
      expect(failed.exitCode).toBe(1);
      expect(new TextDecoder().decode(failed.stderr)).toContain(
        "Isolated native CLI browser journey"
      );
    })
);
