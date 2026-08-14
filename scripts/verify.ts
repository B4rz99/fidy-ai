#!/usr/bin/env bun

const workspaceRoot = Bun.fileURLToPath(new URL("..", import.meta.url)).replace(/\/$/u, "");

type Check = {
  readonly label: string;
  readonly command: ReadonlyArray<string>;
  readonly cwd: string;
  readonly env: typeof Bun.env;
};

const rootCheck = (label: string, command: ReadonlyArray<string>): Check => ({
  label,
  command,
  cwd: workspaceRoot,
  env: Bun.env,
});

const coreEnvironment = { ...Bun.env };
delete coreEnvironment.DATABASE_URL;
delete coreEnvironment.MIGRATION_DATABASE_URL;

const checks: Array<Check> = [
  {
    label: "Install dependency graph analyzer",
    command: ["bun", "install", "--frozen-lockfile"],
    cwd: `${workspaceRoot}/tools/depcruise`,
    env: Bun.env,
  },
  {
    label: "Install CRAP analyzer",
    command: ["bun", "install", "--frozen-lockfile"],
    cwd: `${workspaceRoot}/tools/crap`,
    env: Bun.env,
  },
  rootCheck("Lint suppressions", ["bun", "run", "lint:suppressions"]),
  rootCheck("oxlint", ["bun", "run", "lint"]),
  rootCheck("oxlint type-aware", ["bun", "run", "lint:type-aware"]),
  rootCheck("Format", ["bun", "run", "format:check"]),
  rootCheck("Project-reference build", ["bun", "run", "typecheck"]),
  rootCheck("Module graph", ["bun", "run", "lint:deps"]),
  rootCheck("Browser client graph", ["bun", "run", "check:browser-client"]),
  rootCheck("Web policy integrity", ["bun", "run", "check:policy"]),
  rootCheck("Generated contract freshness", ["bun", "run", "contracts:check:freshness"]),
  rootCheck("Base contract compatibility", ["bun", "run", "contracts:check:compatibility"]),
  rootCheck("Dependency policy", ["bun", "run", "lint:dependencies"]),
  rootCheck("Migration ids", ["bun", "run", "check:migration-ids"]),
  rootCheck("Server production build", ["bun", "run", "build:production"]),
  rootCheck("Portable web build", ["bun", "run", "build"]),
  // Preserve the core tier's proof that decisions need no database, even when the complete CI gate
  // has PostgreSQL configured for higher-seam tests.
  {
    ...rootCheck("Server core tests", ["bun", "run", "test:core"]),
    env: coreEnvironment,
  },
  rootCheck("Web tests", ["bun", "run", "--cwd", "apps/web", "test"]),
  rootCheck("Trusted preview artifact policy", ["bun", "run", "test:preview-policy"]),
  rootCheck("Contract checker tests", ["bun", "run", "test:contracts"]),
  rootCheck("Mutation tests", ["bun", "run", "test:mutation"]),
];

if (Bun.env.PR_TITLE !== undefined) {
  checks.push(rootCheck("PR title", ["bun", "scripts/check-pr-title.ts"]));
}

const databaseConfigured =
  Bun.env.DATABASE_URL !== undefined && Bun.env.MIGRATION_DATABASE_URL !== undefined;
if (databaseConfigured) {
  checks.push(
    rootCheck("Server tests", ["bun", "run", "--cwd", "apps/server", "test"]),
    rootCheck("Observability compatibility", ["bun", "run", "test:observability-compatibility"]),
    rootCheck("WhatsApp acceptance", ["bun", "run", "test:acceptance"]),
    rootCheck("Acceptance coverage ratchet", [
      "git",
      "diff",
      "--exit-code",
      "--",
      "apps/server/vitest.acceptance.config.ts",
    ]),
    rootCheck("CRAP threshold", ["bun", "run", "test:crap"])
  );
} else {
  process.stdout.write(
    "Database-backed tests are not applicable: set DATABASE_URL and MIGRATION_DATABASE_URL to include them.\n"
  );
}

if (Bun.which("docker") !== null) {
  checks.push(rootCheck("Production image", ["bun", "run", "check:production-image"]));
} else {
  process.stdout.write("Production image is not applicable: docker is unavailable.\n");
}

const failed: Array<string> = [];
for (const check of checks) {
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
