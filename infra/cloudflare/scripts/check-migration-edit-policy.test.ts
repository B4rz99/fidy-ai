import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { withSubprocessTestFixture } from "./subprocess-test-fixture";

const scriptPath = fileURLToPath(
  new URL("../../../scripts/check-migration-edit-policy.ts", import.meta.url)
);
const workspaceRoot = fileURLToPath(new URL("../../../", import.meta.url));
const migrationPath = "apps/server/cloudflare/migrations/0001_users.sql";
const pullRequestHead = "b".repeat(40);
const approvalContext = "d1-migration-repair/0001_users.sql";

type PolicyFixture = {
  readonly diff: string;
  readonly statuses: ReadonlyArray<Readonly<Record<string, unknown>>>;
  readonly productionWorkflowRuns: ReadonlyArray<Readonly<Record<string, unknown>>>;
};

const runPolicy = async (
  fixture: PolicyFixture
): Promise<{ readonly args: string; readonly exitCode: number; readonly output: string }> =>
  withSubprocessTestFixture(
    "fidy-migration-policy-",
    async ({ temporaryDirectory, fakeBin, runScript }) => {
      const argsPath = join(temporaryDirectory, "commands.txt");
      const diffPath = join(temporaryDirectory, "diff.bin");
      const statusesPath = join(temporaryDirectory, "statuses.json");
      const productionWorkflowRunsPath = join(temporaryDirectory, "production-workflow-runs.json");

      await writeFile(diffPath, fixture.diff);
      await writeFile(statusesPath, JSON.stringify(fixture.statuses));
      await writeFile(
        productionWorkflowRunsPath,
        JSON.stringify({
          workflow_runs: fixture.productionWorkflowRuns,
        })
      );
      await writeFile(
        join(fakeBin, "git"),
        [
          "#!/usr/bin/env bash",
          'printf "git %s\\n" "$*" >> "$POLICY_COMMANDS"',
          'cat "$POLICY_DIFF"',
          "",
        ].join("\n"),
        { mode: 0o755 }
      );
      await writeFile(
        join(fakeBin, "gh"),
        [
          "#!/usr/bin/env bash",
          'printf "gh %s\\n" "$*" >> "$POLICY_COMMANDS"',
          'if [[ "$*" == *"actions/workflows/production.yml/runs?per_page=1"* ]]; then cat "$POLICY_PRODUCTION_WORKFLOW_RUNS"; else cat "$POLICY_STATUSES"; fi',
          "",
        ].join("\n"),
        { mode: 0o755 }
      );

      const result = runScript({
        scriptPath,
        workingDirectory: workspaceRoot,
        environment: {
          BASE_REF: "origin/trunk",
          GITHUB_ACTIONS: "true",
          GITHUB_REPOSITORY: "B4rz99/fidy-ai",
          GH_TOKEN: "read-only-status-token",
          POLICY_COMMANDS: argsPath,
          POLICY_DIFF: diffPath,
          POLICY_STATUSES: statusesPath,
          POLICY_PRODUCTION_WORKFLOW_RUNS: productionWorkflowRunsPath,
          PR_HEAD_SHA: pullRequestHead,
        },
      });

      return { args: await readFile(argsPath, "utf8"), ...result };
    }
  );

const repairRunUrl = "https://github.com/B4rz99/fidy-ai/actions/runs/42";

const status = (options: {
  readonly id: number;
  readonly state: string;
  readonly creator: string;
}): Readonly<Record<string, unknown>> => ({
  id: options.id,
  context: approvalContext,
  state: options.state,
  created_at: options.state === "pending" ? "2026-09-01T12:01:00.000Z" : "2026-09-01T12:02:00.000Z",
  target_url: repairRunUrl,
  creator: { login: options.creator },
});

describe("PR D1 migration edit policy", () => {
  it("allows adding a new migration without querying Production approval status", async () => {
    const result = await runPolicy({
      diff: `A\0${migrationPath.replace("0001_users", "0002_categories")}\0`,
      statuses: [],
      productionWorkflowRuns: [],
    });

    expect(result.exitCode).toBe(0);
    expect(result.args).not.toContain("gh api");
    expect(result.output).toContain("No existing D1 migration files were edited");
  });

  it("blocks an existing migration edit unless the exact PR head has successful verification", async () => {
    const rejected = await runPolicy({
      diff: `M\0${migrationPath}\0`,
      statuses: [],
      productionWorkflowRuns: [{ status: "completed", updated_at: "2026-09-01T12:00:00.000Z" }],
    });
    const approved = await runPolicy({
      diff: `M\0${migrationPath}\0`,
      statuses: [
        status({ id: 11, state: "pending", creator: "github-actions[bot]" }),
        status({ id: 12, state: "success", creator: "github-actions[bot]" }),
      ],
      productionWorkflowRuns: [{ status: "completed", updated_at: "2026-09-01T12:00:00.000Z" }],
    });

    expect(rejected.exitCode).toBe(1);
    expect(rejected.output).toContain("Verify unapplied D1 migration repair");
    expect(approved.exitCode).toBe(0);
    expect(approved.output).toContain("controlled unapplied-history approvals");
    expect(approved.args).toContain(`commits/${pullRequestHead}/statuses?per_page=100`);
  });

  it("rejects superseded or non-workflow approvals", async () => {
    const staleSuccess = await runPolicy({
      diff: `M\0${migrationPath}\0`,
      statuses: [
        status({ id: 1, state: "pending", creator: "github-actions[bot]" }),
        status({ id: 2, state: "success", creator: "github-actions[bot]" }),
        status({ id: 3, state: "failure", creator: "github-actions[bot]" }),
      ],
      productionWorkflowRuns: [{ status: "completed", updated_at: "2026-09-01T12:00:00.000Z" }],
    });
    const nonWorkflowSuccess = await runPolicy({
      diff: `D\0${migrationPath}\0`,
      statuses: [
        status({ id: 4, state: "pending", creator: "github-actions[bot]" }),
        status({ id: 5, state: "success", creator: "some-user" }),
      ],
      productionWorkflowRuns: [{ status: "completed", updated_at: "2026-09-01T12:00:00.000Z" }],
    });

    expect(staleSuccess.exitCode).toBe(1);
    expect(nonWorkflowSuccess.exitCode).toBe(1);
  });

  it("rejects a repair approval that overlaps a newer Production run", async () => {
    const result = await runPolicy({
      diff: `M\0${migrationPath}\0`,
      statuses: [
        status({ id: 11, state: "pending", creator: "github-actions[bot]" }),
        status({ id: 12, state: "success", creator: "github-actions[bot]" }),
      ],
      productionWorkflowRuns: [{ status: "completed", updated_at: "2026-09-01T12:03:00.000Z" }],
    });

    expect(result.exitCode).toBe(1);
  });
});
