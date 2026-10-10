import { expect } from "vitest";
import { it } from "@effect/vitest";
import { BunFileSystem } from "@effect/platform-bun";
import { Data, Effect, FileSystem } from "effect";

class FixtureProcessFailure extends Data.TaggedError("FixtureProcessFailure") {}

const workspaceRoot = new URL("../", import.meta.url).pathname;
const moduleName = "browser-acceptance-core-module.ts";
const bundleName = "browser-acceptance-core-bundle.mjs";
const temporaryPrefix = ".browser-acceptance-core-";
const previousBundle = 'export const previous = "complete";\n';
const compiler = `#!/usr/bin/env bash
set -eu
for argument in "$@"; do
  case "$argument" in --outfile=*) output="\${argument#--outfile=}" ;; esac
done
wait_for() {
  for attempt in {1..1000}; do
    if [[ -e "$FIXTURE_ROOT/$1" ]]; then return; fi
    sleep 0.01
  done
  printf 'Fixture rendezvous failed: %s\\n' "$1" >&2
  exit 2
}
bundle() {
  printf 'export const makeCoreWorker = () => "%s";\\n' "$FIXTURE_ROLE"
  printf 'export class UserTransactionCoordinator { value = "%s"; }\\n' "$FIXTURE_ROLE"
  printf 'export const runBillingCollectionWorkflow = () => "%s";\\n' "$FIXTURE_ROLE"
}
if [[ "$FIXTURE_ROLE" == failure ]]; then
  printf 'incomplete bundle' > "$output"
  printf 'synthetic compile failure' >&2
  exit 17
elif [[ "$FIXTURE_ROLE" == first ]]; then
  bundle > "$output"
  touch "$FIXTURE_ROOT/first-compiled"
  wait_for second-truncated
else
  wait_for first-compiled
  exec 3> "$output"
  touch "$FIXTURE_ROOT/second-truncated"
  wait_for first-imported
  bundle >&3
fi
`;

const prepareFixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  yield* fs.makeDirectory(`${workspaceRoot}build`, { recursive: true });
  const root = yield* fs.makeTempDirectoryScoped({
    directory: `${workspaceRoot}build`,
    prefix: "browser-core-bundle-",
  });
  yield* fs.makeDirectory(`${root}/bin`);
  yield* fs.copyFile(
    `${workspaceRoot}apps/server/cloudflare/${moduleName}`,
    `${root}/${moduleName}`
  );
  yield* fs.writeFileString(`${root}/bin/bunx`, compiler);
  yield* fs.chmod(`${root}/bin/bunx`, 0o755);
  yield* fs.writeFileString(
    `${root}/probe.ts`,
    `import { makeCoreWorker, UserTransactionCoordinator, runBillingCollectionWorkflow } from "./${moduleName}";
process.stdout.write(JSON.stringify([makeCoreWorker(), new UserTransactionCoordinator().value, runBillingCollectionWorkflow()]));`
  );
  return root;
});

const startImport = Effect.fnUntraced(function* (
  root: string,
  role: "first" | "second" | "failure"
) {
  return yield* Effect.acquireRelease(
    Effect.sync(() =>
      Bun.spawn([process.execPath, `${root}/probe.ts`], {
        env: {
          ...Bun.env,
          PATH: `${root}/bin:${Bun.env.PATH}`,
          FIXTURE_ROOT: root,
          FIXTURE_ROLE: role,
        },
        stdout: "pipe",
        stderr: "pipe",
      })
    ),
    (child) => Effect.sync(() => child.kill())
  );
});

const importResult = Effect.fnUntraced(function* (child: Bun.Subprocess<"ignore", "pipe", "pipe">) {
  const exitCode = yield* Effect.tryPromise({
    try: () => child.exited,
    catch: () => new FixtureProcessFailure(),
  });
  const stdout = yield* Effect.tryPromise({
    try: () => new Response(child.stdout).text(),
    catch: () => new FixtureProcessFailure(),
  });
  const stderr = yield* Effect.tryPromise({
    try: () => new Response(child.stderr).text(),
    catch: () => new FixtureProcessFailure(),
  });
  return { exitCode, stdout, stderr };
});

it.live("imports complete Core exports while another compiler has truncated its output", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const root = yield* prepareFixture;
    const first = yield* startImport(root, "first");
    const second = yield* startImport(root, "second");
    const firstResult = yield* importResult(first);
    yield* fs.writeFileString(`${root}/first-imported`, "");
    const secondResult = yield* importResult(second);
    expect(firstResult).toEqual({ exitCode: 0, stdout: '["first","first","first"]', stderr: "" });
    expect(secondResult).toEqual({
      exitCode: 0,
      stdout: '["second","second","second"]',
      stderr: "",
    });
    expect(
      (yield* fs.readDirectory(root)).filter((name) => name.startsWith(temporaryPrefix))
    ).toEqual([]);
  }).pipe(Effect.provide(BunFileSystem.layer))
);

it.live(
  "preserves the last complete bundle and removes temporary output when compilation fails",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* prepareFixture;
      yield* fs.writeFileString(`${root}/${bundleName}`, previousBundle);
      const result = yield* importResult(yield* startImport(root, "failure"));
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain(
        "Core acceptance fixture failed to compile: synthetic compile failure"
      );
      expect(yield* fs.readFileString(`${root}/${bundleName}`)).toBe(previousBundle);
      expect(
        (yield* fs.readDirectory(root)).filter((name) => name.startsWith(temporaryPrefix))
      ).toEqual([]);
    }).pipe(Effect.provide(BunFileSystem.layer))
);
