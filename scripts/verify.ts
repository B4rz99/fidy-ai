#!/usr/bin/env bun

import { Data, Effect, Option } from "effect";

const workspaceRoot = Bun.fileURLToPath(new URL("..", import.meta.url)).replace(/\/$/u, "");

const verifyGroups = [
  "static",
  "builds",
  "unit",
  "cloudflare-adapters",
  "cloudflare-infra",
  "browser",
  "mutation",
] as const;
type VerifyGroup = (typeof verifyGroups)[number];

type Check = {
  readonly group: VerifyGroup;
  readonly label: string;
  readonly command: ReadonlyArray<string>;
  readonly cwd: string;
  readonly env: typeof Bun.env;
};

const usageError = (message: string): never => {
  process.stderr.write(
    `${message}\nUsage: bun run verify [-- --group ${verifyGroups.join("|")}]\n`
  );
  process.exit(2);
};

const parseGroup = (): Option.Option<VerifyGroup> => {
  const args = Bun.argv.slice(2).filter((argument) => argument !== "--");
  let group: Option.Option<VerifyGroup> = Option.none();

  for (let index = 0; index < args.length; index += 1) {
    const argument = Option.fromUndefinedOr(args[index]);
    if (Option.isNone(argument)) continue;

    let value: Option.Option<string> = Option.none();
    if (argument.value === "--group") {
      index += 1;
      value = Option.fromUndefinedOr(args[index]);
      if (Option.isNone(value)) usageError("--group requires a value");
    } else if (argument.value.startsWith("--group=")) {
      value = Option.some(argument.value.slice("--group=".length));
    } else {
      usageError(`Unknown verify argument: ${argument.value}`);
    }

    if (Option.isSome(group)) usageError("--group may be provided only once");
    const valueText = Option.getOrThrow(value);
    const candidate = Option.fromUndefinedOr(
      verifyGroups.find((verifyGroup) => verifyGroup === valueText)
    );
    if (Option.isNone(candidate)) {
      usageError(`Unknown verification group: ${valueText}`);
    }
    group = candidate;
  }

  return group;
};

const requestedGroup = parseGroup();
const groupIsSelected = (group: VerifyGroup): boolean =>
  Option.isSome(requestedGroup) ? requestedGroup.value === group : group !== "mutation";
const rootCheck = (group: VerifyGroup, label: string, command: ReadonlyArray<string>): Check => ({
  group,
  label,
  command,
  cwd: workspaceRoot,
  env: Bun.env,
});

const gitRevision = new TextDecoder()
  .decode(Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: workspaceRoot }).stdout)
  .trim();

const checks: Array<Check> = [
  {
    group: "static",
    label: "Install dependency graph analyzer",
    command: ["bun", "install", "--frozen-lockfile"],
    cwd: `${workspaceRoot}/tools/depcruise`,
    env: Bun.env,
  },
  rootCheck("static", "Lint suppressions", ["bun", "run", "lint:suppressions"]),
  // Type-aware Oxlint also runs the ordinary rules; do not lint the same workspace twice.
  rootCheck("static", "oxlint type-aware", ["bun", "run", "lint:type-aware"]),
  rootCheck("static", "Format", ["bun", "run", "format:check"]),
  rootCheck("static", "Project-reference build", ["bun", "run", "typecheck"]),
  // The JS plugin is checked with the classic compiler in the isolated tool install;
  // the patched root compiler applies Effect diagnostics to these foreign AST callbacks.
  rootCheck("static", "Oxlint plugin JS types", ["bun", "run", "typecheck:oxlint"]),
  rootCheck("static", "Dependency cruiser JS types", ["bun", "run", "typecheck:depcruise"]),
  rootCheck("static", "Module graph", ["bun", "run", "lint:deps"]),
  rootCheck("static", "Browser client graph", ["bun", "run", "check:browser-client"]),
  rootCheck("static", "Web policy integrity", ["bun", "run", "check:policy"]),
  rootCheck("static", "Web design-system policy", ["bun", "run", "check:design-system"]),
  rootCheck("static", "Shadcn output integrity", ["bun", "run", "check:shadcn"]),
  rootCheck("static", "Generated contract freshness", ["bun", "run", "contracts:check:freshness"]),
  rootCheck("static", "Generated notification-email format freshness", [
    "bun",
    "run",
    "email-formats:check",
  ]),
  rootCheck("static", "Effect dependency family", ["bun", "run", "check:effect-family"]),
  rootCheck("static", "Dependency policy", ["bun", "run", "lint:dependencies"]),
  rootCheck("static", "Credential path evidence", ["bun", "run", "check:credential-evidence"]),
  rootCheck("static", "Reviewed Cloudflare security policy", [
    "bun",
    "infra/cloudflare/verify-edge-policy.ts",
  ]),
  {
    ...rootCheck("builds", "Production web build", [
      "bun",
      "run",
      "--cwd",
      "apps/web",
      "build:production",
    ]),
    env: { ...Bun.env, RELEASE_GIT_SHA: gitRevision },
  },
  rootCheck("unit", "CLI behavior tests", ["bun", "run", "--cwd", "apps/cli", "test"]),
  rootCheck("builds", "Portable web build", ["bun", "run", "build"]),
  rootCheck("builds", "Worker document parsing proof", ["bun", "run", "check:document-parsing"]),
  // Preserve the core tier's proof that business decisions need no platform services.
  {
    ...rootCheck("unit", "Server core tests", ["bun", "run", "test:core"]),
  },
  rootCheck("cloudflare-adapters", "Cloudflare adapter tests", [
    "bun",
    "run",
    "--cwd",
    "apps/server",
    "test:cloudflare",
    ...(Bun.env.CLOUDFLARE_TEST_SHARD !== undefined
      ? [`--shard=${Bun.env.CLOUDFLARE_TEST_SHARD}`]
      : []),
    ...(Bun.env.CLOUDFLARE_TEST_REPORT === "true"
      ? [
          "--reporter=default",
          "--reporter=json",
          "--outputFile=test-results/cloudflare-adapters.json",
        ]
      : []),
  ]),
  rootCheck("cloudflare-infra", "Cloudflare infrastructure tests", [
    "bun",
    "run",
    "--cwd",
    "infra/cloudflare",
    "test",
    ...(Bun.env.CLOUDFLARE_TEST_REPORT === "true"
      ? ["--reporter=default", "--reporter=json", "--outputFile=test-results/cloudflare-infra.json"]
      : []),
  ]),
  rootCheck("unit", "WhatsApp provider boundary tests", [
    "bun",
    "run",
    "--cwd",
    "apps/server",
    "test:whatsapp",
  ]),
  rootCheck("unit", "Canonical declarations and policy tests", [
    "bun",
    "run",
    "--cwd",
    "apps/server",
    "test",
    "--",
    "src/shell/canonical-catalog",
    "src/shell/canonical-policy",
    "src/shell/canonical-operations",
    "src/shell/operations",
    "src/shell/public-http",
    "src/shell/observability/registry.test.ts",
    "src/shell/partial-input/contract.test.ts",
    "src/shell/agent/tool-confirmation-model.test.ts",
    "--coverage.enabled=false",
  ]),
  rootCheck("unit", "Notification-email interpretation tests", [
    "bun",
    "run",
    "--cwd",
    "apps/server",
    "test:email-interpretation",
  ]),
  rootCheck("unit", "Memory owner policy tests", [
    "bun",
    "run",
    "--cwd",
    "apps/server",
    "test:memory",
  ]),
  // Coverage executes the whole web suite, including scripts/production-workflow.test.ts and
  // scripts/cloudflare-adapter.test.ts; separate uninstrumented runs duplicate that evidence.
  rootCheck("unit", "Web tests and Istanbul coverage", [
    "bun",
    "run",
    "--cwd",
    "apps/web",
    "test:coverage",
  ]),
  rootCheck("unit", "CI tooling", ["bun", "run", "test:ci-tools"]),
  rootCheck("unit", "Contract checker tests", ["bun", "run", "test:contracts"]),
  rootCheck("browser", "Web static-shell browser checks", [
    "bun",
    "run",
    "--cwd",
    "apps/web",
    "test:browser",
  ]),
  {
    ...rootCheck("browser", "Isolated native CLI browser journey", [
      "bun",
      "run",
      "--cwd",
      "apps/web",
      "test:browser:cli",
    ]),
    env: { ...Bun.env, CLI_ACCEPTANCE_MODE: "cli" },
  },
  {
    group: "mutation",
    label: "Install mutation runner",
    command: ["bun", "install", "--frozen-lockfile"],
    cwd: `${workspaceRoot}/tools/mutation`,
    env: Bun.env,
  },
  rootCheck("mutation", "Mutation tests", ["bun", "run", "test:mutation"]),
];

if (Bun.env.PR_TITLE !== undefined && groupIsSelected("static")) {
  checks.push(rootCheck("static", "PR title", ["bun", "scripts/check-pr-title.ts"]));
}
if (
  groupIsSelected("static") &&
  (Bun.env.GITHUB_ACTIONS === "true" || Bun.env.BASE_REF !== undefined)
) {
  checks.push(
    rootCheck("static", "Applied D1 migration edit policy", [
      "bun",
      "scripts/check-migration-edit-policy.ts",
    ])
  );
}

const selectedChecks = checks.filter(({ group }) => groupIsSelected(group));
if (Option.isSome(requestedGroup)) {
  process.stdout.write(`Verification group: ${requestedGroup.value}\n`);
}

const verificationStarted = performance.now();
const timings: Array<{ label: string; elapsedMilliseconds: number; exitCode: number }> = [];
const failed: Array<string> = [];
class VerificationProcessFailure extends Data.TaggedError("VerificationProcessFailure")<{
  readonly label: string;
}> {}
const runCheck = (check: Check): Effect.Effect<void> =>
  Effect.gen(function* () {
    process.stdout.write(`\n=== ${check.label} ===\n`);
    const started = performance.now();
    const child = Bun.spawn([...check.command], {
      cwd: check.cwd,
      env: check.env,
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
    });
    const exitCode = yield* Effect.tryPromise({
      try: () => child.exited,
      catch: () => new VerificationProcessFailure({ label: check.label }),
    }).pipe(Effect.orElseSucceed(() => 1));
    const elapsedMilliseconds = Math.round(performance.now() - started);
    timings.push({ label: check.label, elapsedMilliseconds, exitCode });
    process.stdout.write(`Timing: ${check.label}: ${elapsedMilliseconds}ms\n`);
    if (exitCode !== 0) failed.push(check.label);
  });
await Effect.runPromise(
  Effect.forEach(verifyGroups, (group) => {
    const groupChecks = selectedChecks.filter((check) => check.group === group);
    // Browser journeys own separate ports, build outputs, Users and native databases.
    // Overlap their real polling waits on this runner; each suite keeps its worker limit.
    return Effect.forEach(groupChecks, runCheck, {
      concurrency: group === "browser" ? 2 : 1,
      discard: true,
    });
  })
);
const elapsedMilliseconds = Math.round(performance.now() - verificationStarted);
process.stdout.write(`Verification elapsed: ${elapsedMilliseconds}ms (excludes job setup)\n`);
if (Bun.env.VERIFY_TIMING_REPORT !== undefined) {
  await Bun.write(
    Bun.env.VERIFY_TIMING_REPORT,
    JSON.stringify(
      {
        revision: gitRevision,
        platform: process.platform,
        architecture: process.arch,
        runId: Bun.env.GITHUB_RUN_ID,
        attempt: Bun.env.GITHUB_RUN_ATTEMPT,
        group: Option.getOrElse(requestedGroup, () => "all"),
        shard: Bun.env.CLOUDFLARE_TEST_SHARD,
        elapsedMilliseconds,
        checks: timings,
      },
      null,
      2
    )
  );
}

if (failed.length > 0) {
  process.stderr.write(
    `\nRepository verification failed:\n${failed.map((label) => `  - ${label}`).join("\n")}\n`
  );
  process.exit(1);
}
process.stdout.write("\nRepository verification passed.\n");
