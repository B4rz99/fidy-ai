import { afterEach, expect } from "vitest";
import { it } from "@effect/vitest";
import { Data, Effect } from "effect";

class FixtureUnavailable extends Data.TaggedError("FixtureUnavailable") {}

const fixtures: Array<string> = [];
afterEach(() => {
  for (const fixture of fixtures.splice(0)) Bun.spawnSync(["rm", "-rf", fixture]);
});

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
suite=other
if [[ "$*" == *lint:type-aware* ]]; then suite=compiler; fi
if [[ "$*" == *lint:suppressions* ]]; then suite=suppressions; fi
if [[ "$*" == *format:check* ]]; then suite=types; fi
if [[ "$suite" == other ]]; then exit 0; fi
touch "$STATIC_RENDEZVOUS/$suite"
if [[ "$suite" != types ]]; then
  for attempt in {1..100}; do
    if [[ -f "$STATIC_RENDEZVOUS/suppressions" && -f "$STATIC_RENDEZVOUS/compiler" ]]; then break; fi
    sleep 0.01
  done
  [[ -f "$STATIC_RENDEZVOUS/suppressions" && -f "$STATIC_RENDEZVOUS/compiler" ]] || exit 3
fi
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
          `${directory}/compiler`,
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
