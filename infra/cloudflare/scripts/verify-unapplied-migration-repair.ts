#!/usr/bin/env bun

import { spawnSync } from "node:child_process";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import {
  containsRepairableMigrationChange,
  decodeMigrationRepairName,
  decodePullRequestFiles,
  migrationRepairContext,
} from "./migration-history";
import { readProductionMigrationLedger } from "./production-migration-ledger";

const PullRequestNumber = Schema.String.check(Schema.isPattern(/^[1-9][0-9]{0,7}$/u));
const CommitSha = Schema.String.check(Schema.isPattern(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u));
const Repository = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u));
const PullRequest = Schema.Struct({
  state: Schema.Literal("open"),
  base: Schema.Struct({ ref: Schema.Literal("trunk") }),
  head: Schema.Struct({ sha: CommitSha }),
});

const runGitHub = (arguments_: ReadonlyArray<string>): string => {
  const result = spawnSync("gh", ["api", ...arguments_], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.status !== 0) throw new Error("GitHub migration approval request failed");
  return result.stdout;
};

const postStatus = (options: {
  readonly repository: string;
  readonly sha: string;
  readonly context: string;
  readonly state: "failure" | "pending" | "success";
  readonly description: string;
  readonly targetUrl: string;
}): void => {
  runGitHub([
    "--method",
    "POST",
    `repos/${options.repository}/statuses/${options.sha}`,
    "-f",
    `state=${options.state}`,
    "-f",
    `context=${options.context}`,
    "-f",
    `description=${options.description}`,
    "-f",
    `target_url=${options.targetUrl}`,
  ]);
};

type PullRequestData = typeof PullRequest.Type;

const readPullRequest = (repository: string, pullRequestNumber: string): PullRequestData =>
  Schema.decodeUnknownSync(PullRequest)(
    JSON.parse(runGitHub([`repos/${repository}/pulls/${pullRequestNumber}`]))
  );

const readChangedFiles = (
  repository: string,
  pullRequestNumber: string
): ReturnType<typeof decodePullRequestFiles> =>
  decodePullRequestFiles(
    runGitHub([
      "--paginate",
      "--slurp",
      "--jq",
      "add",
      `repos/${repository}/pulls/${pullRequestNumber}/files?per_page=100`,
    ])
  );

const main = (): void => {
  const repository = Schema.decodeUnknownSync(Repository)(process.env.GITHUB_REPOSITORY);
  const pullRequestNumber = Schema.decodeUnknownSync(PullRequestNumber)(
    process.env.MIGRATION_REPAIR_PR_NUMBER
  );
  const migrationName = decodeMigrationRepairName(process.env.MIGRATION_REPAIR_NAME);
  const context = migrationRepairContext(migrationName);
  const pullRequest = readPullRequest(repository, pullRequestNumber);
  const changedFiles = readChangedFiles(repository, pullRequestNumber);
  if (!Effect.runSync(containsRepairableMigrationChange(migrationName, changedFiles))) {
    throw new Error("The requested migration is not an edited, removed, or renamed PR file");
  }

  const serverUrl = process.env.GITHUB_SERVER_URL;
  const runId = process.env.GITHUB_RUN_ID;
  if (serverUrl === undefined || runId === undefined || !/^[0-9]+$/u.test(runId)) {
    throw new Error("GitHub workflow run identity is unavailable");
  }
  const targetUrl = `${serverUrl}/${repository}/actions/runs/${runId}`;
  const statusTarget = {
    repository,
    sha: pullRequest.head.sha,
    context,
    targetUrl,
  } as const;

  postStatus({
    ...statusTarget,
    state: "pending",
    description: "Checking the Production D1 migration ledger.",
  });

  const applied = readProductionMigrationLedger();
  if (applied.some((migration) => migration.name === migrationName)) {
    postStatus({
      ...statusTarget,
      state: "failure",
      description: "Production confirms this migration is applied.",
    });
    process.stderr.write(`D1 migration repair rejected: ${migrationName} is already applied.\n`);
    process.exitCode = 1;
    return;
  }

  postStatus({
    ...statusTarget,
    state: "success",
    description: "Production confirms this migration is unapplied.",
  });
  process.stdout.write(`Production confirms D1 migration ${migrationName} is unapplied.\n`);
};

try {
  main();
} catch {
  process.stderr.write(
    "Unapplied D1 migration repair could not be verified; approval remains blocked.\n"
  );
  process.exitCode = 1;
}
