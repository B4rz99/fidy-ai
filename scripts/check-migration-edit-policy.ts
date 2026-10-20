#!/usr/bin/env bun

import * as Effect from "effect/Effect";
import type * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type {
  GitMigrationChange,
  MigrationRepairStatus,
  ProductionWorkflowRunSnapshot,
} from "../infra/cloudflare/scripts/migration-history";
import {
  MigrationRepairCommitSha,
  MigrationRepairRepository,
  decodeLatestProductionWorkflowRun,
  decodeMigrationRepairStatuses,
  parseGitMigrationChanges,
  unapprovedMigrationChanges,
} from "../infra/cloudflare/scripts/migration-history";

const workspaceRoot = Bun.fileURLToPath(new URL("..", import.meta.url));
const GitReference = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_./-]+$/u));

const runMigrationEditPolicyCommand = (command: readonly [string, ...Array<string>]): string => {
  const result = Bun.spawnSync([...command], {
    cwd: workspaceRoot,
    stderr: "pipe",
    stdin: "ignore",
    stdout: "pipe",
  });
  if (result.exitCode !== 0) throw new Error("Migration edit policy command failed");
  return new TextDecoder().decode(result.stdout);
};

const readMigrationRepairEvidence = (
  repository: string,
  headSha: string
): {
  readonly statuses: ReadonlyArray<MigrationRepairStatus>;
  readonly latestProductionRun: Option.Option<ProductionWorkflowRunSnapshot>;
} => ({
  statuses: decodeMigrationRepairStatuses(
    runMigrationEditPolicyCommand([
      "gh",
      "api",
      "--paginate",
      "--slurp",
      `repos/${repository}/commits/${headSha}/statuses?per_page=100`,
    ])
  ),
  latestProductionRun: decodeLatestProductionWorkflowRun(
    runMigrationEditPolicyCommand([
      "gh",
      "api",
      `repos/${repository}/actions/workflows/production.yml/runs?per_page=1`,
    ])
  ),
});

const migrationFilesAt = (ref: string): ReadonlyArray<string> =>
  runMigrationEditPolicyCommand([
    "git",
    "ls-tree",
    "-r",
    "--name-only",
    ref,
    "--",
    "apps/server/cloudflare/migrations",
  ])
    .trim()
    .split("\n")
    .filter((name) => name.endsWith(".sql"))
    .sort();

/** Only the already reviewed schema snapshot may replace the complete migration directory. */
const isVerifiedBaselineSquash = (
  changes: ReadonlyArray<GitMigrationChange>,
  base: string
): boolean => {
  const baseline = "apps/server/cloudflare/migrations/0001_schema.sql";
  if (!changes.some((change) => change.status === "A" && change.path === baseline)) {
    return false;
  }
  if (
    !changes.every(
      (change) => change.status === "D" || (change.status === "A" && change.path === baseline)
    )
  ) {
    return false;
  }
  const files = migrationFilesAt("HEAD");
  if (files.length !== 1 || files[0] !== baseline) {
    return false;
  }
  const previous = migrationFilesAt(base);
  const deleted = changes
    .filter((change) => change.status === "D")
    .map((change) => change.path)
    .sort();
  if (JSON.stringify(previous) !== JSON.stringify(deleted)) {
    return false;
  }
  return (
    runMigrationEditPolicyCommand(["git", "show", `HEAD:${baseline}`])
      .replace(/^--> statement-breakpoint\n/gmu, "")
      .trim() ===
    runMigrationEditPolicyCommand([
      "git",
      "show",
      `${base}:apps/server/cloudflare/schema.sql`,
    ]).trim()
  );
};

const outsidePullRequest = (): boolean =>
  Bun.env.BASE_REF === undefined && Bun.env.GITHUB_ACTIONS !== "true";

const main = (): void => {
  const baseRef = Bun.env.BASE_REF;
  if (outsidePullRequest()) {
    process.stdout.write("Skipped the PR-only migration edit policy outside GitHub Actions.\n");
    return;
  }
  const base = Schema.decodeUnknownSync(GitReference)(baseRef);
  const changes = parseGitMigrationChanges(
    runMigrationEditPolicyCommand([
      "git",
      "diff",
      "--name-status",
      "--no-renames",
      "-z",
      base,
      "HEAD",
      "--",
      "apps/server/cloudflare/migrations",
    ])
  );
  if (changes.every(({ status }) => status === "A")) {
    process.stdout.write("No existing D1 migration files were edited, removed, or renamed.\n");
    return;
  }

  if (isVerifiedBaselineSquash(changes, base)) {
    process.stdout.write(
      "The sole D1 baseline exactly matches the base branch's reviewed schema snapshot.\n"
    );
    return;
  }

  const headSha = Schema.decodeUnknownSync(MigrationRepairCommitSha)(Bun.env.PR_HEAD_SHA);
  const repository = Schema.decodeUnknownSync(MigrationRepairRepository)(Bun.env.GITHUB_REPOSITORY);
  if (Bun.env.GH_TOKEN === undefined || Bun.env.GH_TOKEN.length === 0) {
    throw new Error("GitHub status access is unavailable");
  }
  const evidence = readMigrationRepairEvidence(repository, headSha);
  const unapproved = Effect.runSync(
    unapprovedMigrationChanges(changes, evidence.statuses, evidence.latestProductionRun)
  );
  if (unapproved.length > 0) {
    for (const name of unapproved) {
      process.stderr.write(
        `D1 migration ${name} is immutable without an unapplied-migration verification. ` +
          `Run the "Verify unapplied D1 migration repair" workflow from trunk for this PR and migration.\n`
      );
    }
    process.exitCode = 1;
    return;
  }

  process.stdout.write(
    "Changed existing D1 migrations have controlled unapplied-history approvals.\n"
  );
};

try {
  main();
} catch {
  process.stderr.write(
    "D1 migration edit policy could not be verified; pull request validation is blocked.\n"
  );
  process.exitCode = 1;
}
