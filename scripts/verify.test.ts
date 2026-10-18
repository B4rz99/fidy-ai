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
if [[ "$*" == *"apps/site"* ]]; then journey_mode="site"; fi
printf "CHECK mode=%s args=%s \\n" "$journey_mode" "$*"
touch "\${JOURNEY_RENDEZVOUS}/$journey_mode"
if [[ "$journey_mode" == "site" ]]; then
  [[ "\${FAIL_JOURNEY:-}" != "site" ]] || exit 1
  exit 0
fi
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
          BROWSER_TEST_SHARD: undefined,
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
      "CHECK mode=site args=run --cwd apps/site test:browser ",
    ]);
    const failureLabels = {
      cli: "Isolated native CLI browser journey",
      shared: "Web static-shell browser checks",
      site: "Public site browser checks",
    };
    for (const journey of ["cli", "shared", "site"] as const) {
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
            BROWSER_TEST_SHARD: undefined,
            FAIL_JOURNEY: journey,
            JOURNEY_RENDEZVOUS: directory,
            PATH: `${directory}:${Bun.env.PATH}`,
          },
        }
      );
      expect(failed.exitCode).toBe(1);
      expect(new TextDecoder().decode(failed.stderr)).toContain(failureLabels[journey]);
    }
  })
);

it.effect(
  "runs every browser shard but the isolated CLI journey only once, and propagates failures",
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
            `#!/usr/bin/env bash
printf 'CHECK %s\\n' "$*"
exit "\${CHECK_EXIT_CODE:-0}"
`
          ),
        catch: () => new FixtureUnavailable(),
      });
      expect(Bun.spawnSync(["chmod", "+x", `${directory}/bun`]).exitCode).toBe(0);
      for (const shard of ["1/2", "2/2"]) {
        for (const exitCode of [0, 1]) {
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
                BROWSER_TEST_SHARD: shard,
                CHECK_EXIT_CODE: String(exitCode),
                PATH: `${directory}:${Bun.env.PATH}`,
              },
            }
          );
          expect(result.exitCode).toBe(exitCode);
          const commands = new TextDecoder()
            .decode(result.stdout)
            .split("\n")
            .filter((line) => line.startsWith("CHECK "));
          expect(commands).toContain(`CHECK run --cwd apps/web test:browser --shard=${shard}`);
          expect(commands.includes("CHECK run --cwd apps/web test:browser:cli")).toBe(
            shard === "1/2"
          );
          expect(commands).toContain("CHECK run --cwd apps/site test:browser");
          expect(commands).toHaveLength(shard === "1/2" ? 3 : 2);
        }
      }
    })
);
