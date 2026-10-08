import { afterEach, expect } from "vitest";
import { it } from "@effect/vitest";
import { Data, Effect } from "effect";

class FixtureUnavailable extends Data.TaggedError("FixtureUnavailable") {}

const fixtures: Array<string> = [];
afterEach(() => {
  for (const fixture of fixtures.splice(0)) Bun.spawnSync(["rm", "-rf", fixture]);
});

it.effect("overlaps isolated browser journeys and reports either journey's failure", () =>
  Effect.gen(function* () {
    const temporary = Bun.spawnSync(["mktemp", "-d"]);
    expect(temporary.exitCode).toBe(0);
    const directory = new TextDecoder().decode(temporary.stdout).trim();
    fixtures.push(directory);
    yield* Effect.tryPromise({
      try: () =>
        Bun.write(
          `${directory}/bun`,
          `#!/usr/bin/env bash
set -eu
journey_mode="\${CLI_ACCEPTANCE_MODE:-shared}"
printf "CHECK mode=%s args=%s \\n" "$journey_mode" "$*"
touch "\${JOURNEY_RENDEZVOUS}/$journey_mode"
for attempt in {1..100}; do
  if [[ -e "\${JOURNEY_RENDEZVOUS}/shared" && -e "\${JOURNEY_RENDEZVOUS}/cli" ]]; then break; fi
  sleep 0.01
done
[[ -e "\${JOURNEY_RENDEZVOUS}/shared" && -e "\${JOURNEY_RENDEZVOUS}/cli" ]] || exit 2
if [[ "\${FAIL_JOURNEY:-}" == "$journey_mode" ]]; then exit 1; fi
`
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
        env: {
          ...Bun.env,
          CLI_ACCEPTANCE_MODE: undefined,
          JOURNEY_RENDEZVOUS: directory,
          PATH: `${directory}:${Bun.env.PATH}`,
        },
      }
    );
    expect(result.exitCode).toBe(0);
    expect(
      new TextDecoder()
        .decode(result.stdout)
        .split("\n")
        .filter((line) => line.startsWith("CHECK "))
        .sort()
    ).toEqual([
      "CHECK mode=cli args=run --cwd apps/web test:browser:cli ",
      "CHECK mode=shared args=run --cwd apps/web test:browser ",
    ]);
    for (const journey of ["cli", "shared"]) {
      expect(Bun.spawnSync(["rm", `${directory}/shared`, `${directory}/cli`]).exitCode).toBe(0);
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
            FAIL_JOURNEY: journey,
            JOURNEY_RENDEZVOUS: directory,
            PATH: `${directory}:${Bun.env.PATH}`,
          },
        }
      );
      expect(failed.exitCode).toBe(1);
      expect(new TextDecoder().decode(failed.stderr)).toContain(
        journey === "cli"
          ? "Isolated native CLI browser journey"
          : "Web static-shell browser checks"
      );
    }
  })
);
