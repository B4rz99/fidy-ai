import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { withSubprocessTestFixture } from "./subprocess-test-fixture";

const scriptPath = fileURLToPath(
  new URL("./verify-unapplied-migration-repair.ts", import.meta.url)
);
const infrastructureDirectory = fileURLToPath(new URL("../", import.meta.url));
const pullRequestNumber = "42";
const pullRequestHead = "c".repeat(40);
const migrationName = "0024_hosted_whatsapp.sql";
const migrationPath = `apps/server/cloudflare/migrations/${migrationName}`;
const stateOutput = {
  attr: {
    databaseName: "FidyCloudflare-Database-production-test",
    migrationsTable: "__alchemy_migrations",
  },
};

type RepairFixture = {
  readonly ledgerRows: ReadonlyArray<Readonly<Record<string, unknown>>>;
  readonly changedFiles: ReadonlyArray<Readonly<Record<string, unknown>>>;
  readonly wranglerExitCode: number;
};

const validFixture: RepairFixture = {
  ledgerRows: [],
  changedFiles: [{ filename: migrationPath, status: "modified" }],
  wranglerExitCode: 0,
};

const runRepair = async (
  fixture: RepairFixture = validFixture
): Promise<{ readonly args: string; readonly exitCode: number; readonly output: string }> =>
  withSubprocessTestFixture(
    "fidy-d1-repair-",
    async ({ temporaryDirectory, fakeBin, runScript }) => {
      const argsPath = join(temporaryDirectory, "commands.txt");
      const statePath = join(temporaryDirectory, "state.json");
      const rowsPath = join(temporaryDirectory, "rows.json");
      const filesPath = join(temporaryDirectory, "files.json");

      await writeFile(statePath, JSON.stringify(stateOutput));
      await writeFile(
        rowsPath,
        JSON.stringify([
          {
            results: fixture.ledgerRows,
            success: true,
          },
        ])
      );
      await writeFile(filesPath, JSON.stringify(fixture.changedFiles));
      await writeFile(
        join(fakeBin, "bun"),
        [
          "#!/usr/bin/env bash",
          'printf "bun %s\\n" "$*" >> "$REPAIR_COMMANDS"',
          'if [[ "$*" == *"alchemy.ts state read"* ]]; then',
          '  cat "$REPAIR_STATE"',
          'elif [[ "$*" == *"run wrangler d1 execute"* ]]; then',
          '  cat "$REPAIR_ROWS"',
          '  exit "${WRANGLER_EXIT_CODE:-0}"',
          "else",
          "  exit 97",
          "fi",
          "",
        ].join("\n"),
        { mode: 0o755 }
      );
      await writeFile(
        join(fakeBin, "gh"),
        [
          "#!/usr/bin/env bash",
          'printf "gh %s\\n" "$*" >> "$REPAIR_COMMANDS"',
          'if [[ "$*" == *"--method POST"* ]]; then',
          "  exit 0",
          'elif [[ "$*" == *"/pulls/42/files"* ]]; then',
          '  cat "$REPAIR_FILES"',
          'elif [[ "$*" == *"/pulls/42"* ]]; then',
          "  printf '%s\\n' \"$REPAIR_PR\"",
          "else",
          "  exit 98",
          "fi",
          "",
        ].join("\n"),
        { mode: 0o755 }
      );

      const pullRequest = JSON.stringify({
        base: { ref: "trunk" },
        head: { sha: pullRequestHead },
        state: "open",
      });
      const result = runScript({
        scriptPath,
        workingDirectory: infrastructureDirectory,
        environment: {
          ALCHEMY_PROFILE: "ci",
          CLOUDFLARE_ACCOUNT_ID: "00000000000000000000000000000000",
          CLOUDFLARE_API_TOKEN: "local-only-repair-test-token",
          GITHUB_REPOSITORY: "B4rz99/fidy-ai",
          GITHUB_RUN_ID: "12345",
          GITHUB_SERVER_URL: "https://github.com",
          GH_TOKEN: "local-only-github-status-token",
          MIGRATION_REPAIR_NAME: migrationName,
          MIGRATION_REPAIR_PR_NUMBER: pullRequestNumber,
          REPAIR_COMMANDS: argsPath,
          REPAIR_FILES: filesPath,
          REPAIR_PR: pullRequest,
          REPAIR_ROWS: rowsPath,
          REPAIR_STATE: statePath,
          WRANGLER_EXIT_CODE: String(fixture.wranglerExitCode),
        },
      });

      return { args: await readFile(argsPath, "utf8"), ...result };
    }
  );

describe("controlled D1 migration repair verification", () => {
  it("posts approval only after Production confirms the requested PR migration is unapplied", async () => {
    const result = await runRepair({
      ...validFixture,
      changedFiles: [
        {
          filename: "apps/server/cloudflare/migrations/0025_voice_refusal.sql",
          previous_filename: migrationPath,
          status: "renamed",
        },
      ],
    });

    expect(result.exitCode).toBe(0);
    expect(result.output).toContain(
      `Production confirms D1 migration ${migrationName} is unapplied.`
    );
    expect(result.args).toContain(`statuses/${pullRequestHead}`);
    expect(result.args).toContain("state=pending");
    expect(result.args).toContain("state=success");
    expect(result.args).not.toContain("state=failure");
    expect(result.output).not.toContain("local-only-repair-test-token");
  });

  it("rejects an applied migration and leaves a failure status instead of approval", async () => {
    const result = await runRepair({
      ...validFixture,
      ledgerRows: [
        {
          name: migrationName,
          hash: "a".repeat(64),
          ledger_count: 1,
        },
      ],
    });

    expect(result.exitCode).toBe(1);
    expect(result.output).toContain("is already applied");
    expect(result.args).toContain("state=pending");
    expect(result.args).toContain("state=failure");
    expect(result.args).not.toContain("state=success");
  });

  it("does not approve a filename that is not an existing changed PR migration", async () => {
    const result = await runRepair({
      ...validFixture,
      changedFiles: [
        {
          filename: "apps/server/cloudflare/migrations/0025_voice_refusal.sql",
          status: "added",
        },
      ],
    });

    expect(result.exitCode).toBe(1);
    expect(result.args).not.toContain("statuses/");
    expect(result.output).toContain("could not be verified; approval remains blocked");
  });

  it("leaves verification pending when Production cannot be queried", async () => {
    const result = await runRepair({ ...validFixture, wranglerExitCode: 1 });

    expect(result.exitCode).toBe(1);
    expect(result.args).toContain("state=pending");
    expect(result.args).not.toContain("state=success");
    expect(result.output).toContain("could not be verified; approval remains blocked");
  });
});
