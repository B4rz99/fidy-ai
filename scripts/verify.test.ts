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
if [[ "$journey_mode" == shared ]]; then
  [[ ! -e "\${JOURNEY_RENDEZVOUS}/cli" ]] || exit 3
  printf 'FIDY_BROWSER_LATENCY_VERIFIED\\n'
fi
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
    ]);
    const failureLabels = {
      cli: "Isolated native CLI browser journey",
      shared: "Web static-shell browser checks",
    };
    for (const journey of ["cli", "shared"] as const) {
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
if [[ "\${CHECK_NO_BROWSER_PHASE:-}" != 1 && "$*" == *test:browser* && "$*" != *test:browser:cli* ]]; then printf 'FIDY_BROWSER_LATENCY_VERIFIED\\n'; fi
if [[ -n "\${CHECK_FAIL_MATCH:-}" && "$*" == *"$CHECK_FAIL_MATCH"* ]]; then exit 1; fi
exit "\${CHECK_EXIT_CODE:-0}"
`
          ),
        catch: () => new FixtureUnavailable(),
      });
      expect(Bun.spawnSync(["chmod", "+x", `${directory}/bun`]).exitCode).toBe(0);
      for (const exitCode of [0, 1]) {
        const result = Bun.spawnSync(
          [
            process.execPath,
            Bun.fileURLToPath(new URL("./verify.ts", import.meta.url)),
            "--group",
            "builds",
          ],
          {
            env: {
              ...Bun.env,
              CHECK_EXIT_CODE: String(exitCode),
              PATH: `${directory}:${Bun.env.PATH}`,
            },
          }
        );
        expect(result.exitCode).toBe(exitCode);
        const siteChecks = new TextDecoder()
          .decode(result.stdout)
          .split("\n")
          .filter((line) => line === "CHECK run --cwd apps/site test:browser");
        expect(siteChecks).toHaveLength(1);
      }
      const failedSite = Bun.spawnSync(
        [
          process.execPath,
          Bun.fileURLToPath(new URL("./verify.ts", import.meta.url)),
          "--group",
          "builds",
        ],
        {
          env: {
            ...Bun.env,
            CHECK_FAIL_MATCH: "apps/site test:browser",
            PATH: `${directory}:${Bun.env.PATH}`,
          },
        }
      );
      expect(failedSite.exitCode).toBe(1);
      expect(new TextDecoder().decode(failedSite.stderr)).toContain("Public site browser checks");
      const missingPhase = Bun.spawnSync(
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
            BROWSER_TEST_SHARD: "1/2",
            CHECK_NO_BROWSER_PHASE: "1",
            PATH: `${directory}:${Bun.env.PATH}`,
          },
        }
      );
      expect(missingPhase.exitCode).toBe(1);
      expect(new TextDecoder().decode(missingPhase.stdout)).not.toContain(
        "CHECK run --cwd apps/web test:browser:cli"
      );
      expect(new TextDecoder().decode(missingPhase.stderr)).toContain(
        "Isolated native CLI browser journey"
      );
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
          expect(commands).not.toContain("CHECK run --cwd apps/site test:browser");
          expect(commands).toHaveLength(shard === "1/2" ? 2 : 1);
        }
      }
    })
);

it.effect("overlaps unit suites within four workers and propagates either suite's failure", () =>
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
[[ "$*" == *"--maxWorkers=2"* ]] || exit 3
suite=other
if [[ "$*" == *"apps/cli"* ]]; then suite=cli; fi
if [[ "$*" == *"test:core"* ]]; then suite=core; fi
printf 'CHECK %s\\n' "$*"
if [[ "$suite" == other ]]; then exit 0; fi
touch "\${UNIT_RENDEZVOUS}/$suite"
for attempt in {1..100}; do
  if [[ -e "\${UNIT_RENDEZVOUS}/cli" && -e "\${UNIT_RENDEZVOUS}/core" ]]; then break; fi
  sleep 0.01
done
[[ -e "\${UNIT_RENDEZVOUS}/cli" && -e "\${UNIT_RENDEZVOUS}/core" ]] || exit 2
[[ "\${FAIL_SUITE:-}" != "$suite" ]] || exit 1
`
        ),
      catch: () => new FixtureUnavailable(),
    });
    expect(Bun.spawnSync(["chmod", "+x", `${directory}/bun`]).exitCode).toBe(0);
    for (const failure of ["", "cli", "core"]) {
      Bun.spawnSync(["rm", "-f", `${directory}/cli`, `${directory}/core`]);
      const result = Bun.spawnSync(
        [
          process.execPath,
          Bun.fileURLToPath(new URL("./verify.ts", import.meta.url)),
          "--group",
          "unit",
        ],
        {
          env: {
            ...Bun.env,
            UNIT_RENDEZVOUS: directory,
            FAIL_SUITE: failure,
            PATH: `${directory}:${Bun.env.PATH}`,
          },
        }
      );
      expect(result.exitCode).toBe(failure === "" ? 0 : 1);
      if (failure === "") {
        expect(new TextDecoder().decode(result.stdout).match(/^CHECK /gmu)).toHaveLength(9);
      } else {
        expect(new TextDecoder().decode(result.stderr)).toContain(
          failure === "cli" ? "CLI behavior tests" : "Server core tests"
        );
      }
    }
  })
);

it.effect(
  "installs static prerequisites before overlapping independent checks and retains failures",
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
set -eu
if [[ "$*" == 'install --frozen-lockfile' ]]; then
  touch "$STATIC_RENDEZVOUS/installed"
  exit 0
fi
[[ -f "$STATIC_RENDEZVOUS/installed" ]] || exit 2
[[ "\${GOMAXPROCS:-}" == 4 ]] || exit 4
if [[ "$*" == *lint:rules* ]]; then
  [[ ! -f "$STATIC_RENDEZVOUS/suppressions" && ! -f "$STATIC_RENDEZVOUS/types" ]] || exit 5
  touch "$STATIC_RENDEZVOUS/rules-complete"
  [[ "\${FAIL_STATIC:-}" != rules ]] || exit 1
  exit 0
fi
[[ -f "$STATIC_RENDEZVOUS/rules-complete" ]] || exit 6
if [[ "$*" == *lint:type-aware* ]]; then
  [[ ! -f "$STATIC_RENDEZVOUS/suppressions" && ! -f "$STATIC_RENDEZVOUS/types" ]] || exit 7
  touch "$STATIC_RENDEZVOUS/compiler-complete"
  [[ "\${FAIL_STATIC:-}" != compiler ]] || exit 1
  exit 0
fi
[[ -f "$STATIC_RENDEZVOUS/compiler-complete" ]] || exit 8
suite=other
if [[ "$*" == *lint:suppressions* ]]; then suite=suppressions; fi
if [[ "$*" == *format:check* ]]; then suite=types; fi
if [[ "$suite" == other ]]; then exit 0; fi
touch "$STATIC_RENDEZVOUS/$suite"
for attempt in {1..100}; do
  if [[ -f "$STATIC_RENDEZVOUS/suppressions" && -f "$STATIC_RENDEZVOUS/types" ]]; then break; fi
  sleep 0.01
done
[[ -f "$STATIC_RENDEZVOUS/suppressions" && -f "$STATIC_RENDEZVOUS/types" ]] || exit 3
[[ "\${FAIL_STATIC:-}" != "$suite" ]] || exit 1
`
          ),
        catch: () => new FixtureUnavailable(),
      });
      expect(Bun.spawnSync(["chmod", "+x", `${directory}/bun`]).exitCode).toBe(0);
      for (const failure of ["", "rules", "compiler", "suppressions", "types"] as const) {
        Bun.spawnSync([
          "rm",
          "-f",
          `${directory}/installed`,
          `${directory}/rules-complete`,
          `${directory}/compiler-complete`,
          `${directory}/suppressions`,
          `${directory}/types`,
        ]);
        const result = Bun.spawnSync(
          [
            process.execPath,
            Bun.fileURLToPath(new URL("./verify.ts", import.meta.url)),
            "--group",
            "static",
          ],
          {
            env: {
              ...Bun.env,
              STATIC_RENDEZVOUS: directory,
              FAIL_STATIC: failure,
              PATH: `${directory}:${Bun.env.PATH}`,
            },
          }
        );
        expect(result.exitCode).toBe(failure === "" ? 0 : 1);
        if (failure !== "") {
          const labels = {
            rules: "Lint rule regressions",
            types: "Format",
            compiler: "oxlint type-aware",
            suppressions: "Lint suppressions",
          };
          expect(new TextDecoder().decode(result.stderr)).toContain(labels[failure]);
        }
      }
    })
);
