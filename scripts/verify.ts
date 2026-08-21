#!/usr/bin/env bun

import { Option } from "effect";

const workspaceRoot = Bun.fileURLToPath(new URL("..", import.meta.url)).replace(/\/$/u, "");

const verifyGroups = [
  "static",
  "builds",
  "unit",
  "browser",
  "server",
  "acceptance",
  "quality",
  "mutation",
  "image",
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
  Option.isNone(requestedGroup) || requestedGroup.value === group;
const rootCheck = (group: VerifyGroup, label: string, command: ReadonlyArray<string>): Check => ({
  group,
  label,
  command,
  cwd: workspaceRoot,
  env: Bun.env,
});

const coreEnvironment = { ...Bun.env };
delete coreEnvironment.DATABASE_URL;
delete coreEnvironment.MIGRATION_DATABASE_URL;
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
  rootCheck("static", "oxlint", ["bun", "run", "lint"]),
  rootCheck("static", "oxlint type-aware", ["bun", "run", "lint:type-aware"]),
  rootCheck("static", "Format", ["bun", "run", "format:check"]),
  rootCheck("static", "Project-reference build", ["bun", "run", "typecheck"]),
  rootCheck("static", "Module graph", ["bun", "run", "lint:deps"]),
  rootCheck("static", "Browser client graph", ["bun", "run", "check:browser-client"]),
  rootCheck("static", "Web policy integrity", ["bun", "run", "check:policy"]),
  rootCheck("static", "Shadcn output integrity", ["bun", "run", "check:shadcn"]),
  rootCheck("static", "Generated contract freshness", ["bun", "run", "contracts:check:freshness"]),
  rootCheck("static", "Base contract compatibility", [
    "bun",
    "run",
    "contracts:check:compatibility",
  ]),
  rootCheck("static", "Dependency policy", ["bun", "run", "lint:dependencies"]),
  rootCheck("static", "Migration ids", ["bun", "run", "check:migration-ids"]),
  rootCheck("static", "Credential path evidence", ["bun", "run", "check:credential-evidence"]),
  rootCheck("builds", "Server production build", ["bun", "run", "build:production"]),
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
  rootCheck("builds", "Portable web build", ["bun", "run", "build"]),
  // Preserve the core tier's proof that decisions need no database, even when the complete CI gate
  // has PostgreSQL configured for higher-seam tests.
  {
    ...rootCheck("unit", "Server core tests", ["bun", "run", "test:core"]),
    env: coreEnvironment,
  },
  rootCheck("unit", "Web tests", ["bun", "run", "--cwd", "apps/web", "test"]),
  rootCheck("unit", "Web Istanbul coverage", ["bun", "run", "--cwd", "apps/web", "test:coverage"]),
  rootCheck("unit", "Trusted preview artifact policy", ["bun", "run", "test:preview-policy"]),
  rootCheck("unit", "Production deployment adapters", ["bun", "run", "test:production-adapters"]),
  rootCheck("unit", "Contract checker tests", ["bun", "run", "test:contracts"]),
  rootCheck("browser", "Web static-shell browser checks", [
    "bun",
    "run",
    "--cwd",
    "apps/web",
    "test:browser",
  ]),
  {
    group: "quality",
    label: "Install CRAP analyzer",
    command: ["bun", "install", "--frozen-lockfile"],
    cwd: `${workspaceRoot}/tools/crap`,
    env: Bun.env,
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

const databaseGroups = new Set<VerifyGroup>(["server", "acceptance", "quality"]);
const databaseConfigured =
  Bun.env.DATABASE_URL !== undefined && Bun.env.MIGRATION_DATABASE_URL !== undefined;
const runsDatabaseGroup = Option.isNone(requestedGroup) || databaseGroups.has(requestedGroup.value);

if (runsDatabaseGroup) {
  if (databaseConfigured) {
    checks.push(
      rootCheck("server", "Server tests", ["bun", "run", "--cwd", "apps/server", "test"]),
      rootCheck("server", "Observability compatibility", [
        "bun",
        "run",
        "test:observability-compatibility",
      ]),
      rootCheck("acceptance", "WhatsApp acceptance", ["bun", "run", "test:acceptance"]),
      rootCheck("acceptance", "Acceptance coverage ratchet", [
        "git",
        "diff",
        "--exit-code",
        "--",
        "apps/server/vitest.acceptance.config.ts",
      ]),
      rootCheck("quality", "CRAP threshold", ["bun", "run", "test:crap"])
    );
  } else {
    process.stdout.write(
      "Database-backed tests are not applicable: set DATABASE_URL and MIGRATION_DATABASE_URL to include them.\n"
    );
  }
}

if (groupIsSelected("image")) {
  if (Bun.which("docker") !== null) {
    checks.push(rootCheck("image", "Production image", ["bun", "run", "check:production-image"]));
  } else {
    process.stdout.write("Production image is not applicable: docker is unavailable.\n");
  }
}

const selectedChecks = checks.filter(({ group }) => groupIsSelected(group));
if (Option.isSome(requestedGroup)) {
  process.stdout.write(`Verification group: ${requestedGroup.value}\n`);
}

const failed: Array<string> = [];
for (const check of selectedChecks) {
  process.stdout.write(`\n=== ${check.label} ===\n`);
  const result = Bun.spawnSync([...check.command], {
    cwd: check.cwd,
    env: check.env,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  if (result.exitCode !== 0) failed.push(check.label);
}

if (failed.length > 0) {
  process.stderr.write(
    `\nRepository verification failed:\n${failed.map((label) => `  - ${label}`).join("\n")}\n`
  );
  process.exit(1);
}
process.stdout.write("\nRepository verification passed.\n");
