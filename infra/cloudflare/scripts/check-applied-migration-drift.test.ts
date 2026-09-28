import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  installFakeMigrationHistoryBun,
  withSubprocessTestFixture,
} from "./subprocess-test-fixture";

const scriptPath = fileURLToPath(new URL("./check-applied-migration-drift.ts", import.meta.url));
const infrastructureDirectory = fileURLToPath(new URL("../", import.meta.url));
const appliedName = "0001_categories.sql";
const appliedHash = "5c14f7a6901179f89f5ee798c2ff69c36873f2de52316a08478a1fbff92e2019";

type GateFixture = {
  readonly state: unknown;
  readonly stateLogs: string;
  readonly rows: ReadonlyArray<Readonly<Record<string, unknown>>>;
  readonly wranglerExitCode: number;
};

const validState = {
  attr: {
    databaseName: "FidyCloudflare-Database-production-test",
    migrationsTable: "__alchemy_migrations",
  },
};
const validRows = [{ name: appliedName, hash: appliedHash, ledger_count: 1 }];
const validFixture: GateFixture = {
  state: validState,
  stateLogs:
    "• Refreshing Cloudflare State Store credentials\n✓ Refreshing Cloudflare State Store credentials\n",
  rows: validRows,
  wranglerExitCode: 0,
};

const runGate = async (
  fixture: GateFixture
): Promise<{ readonly args: string; readonly exitCode: number; readonly output: string }> =>
  withSubprocessTestFixture(
    "fidy-d1-history-",
    async ({ temporaryDirectory, fakeBin, runScript }) => {
      const argsPath = join(temporaryDirectory, "commands.txt");
      const statePath = join(temporaryDirectory, "state.json");
      const stateLogsPath = join(temporaryDirectory, "state-logs.txt");
      const rowsPath = join(temporaryDirectory, "rows.json");
      await writeFile(statePath, JSON.stringify(fixture.state));
      await writeFile(stateLogsPath, fixture.stateLogs);
      await writeFile(
        rowsPath,
        JSON.stringify([
          {
            results: fixture.rows,
            success: true,
          },
        ])
      );
      await installFakeMigrationHistoryBun(fakeBin);

      const result = runScript({
        scriptPath,
        workingDirectory: infrastructureDirectory,
        environment: {
          ALCHEMY_PROFILE: "ci",
          CLOUDFLARE_ACCOUNT_ID: "00000000000000000000000000000000",
          CLOUDFLARE_API_TOKEN: "local-only-migration-test-token",
          MIGRATION_COMMANDS: argsPath,
          MIGRATION_ROWS: rowsPath,
          MIGRATION_STATE: statePath,
          MIGRATION_STATE_LOGS: stateLogsPath,
          WRANGLER_EXIT_CODE: String(fixture.wranglerExitCode),
        },
      });

      return { args: await readFile(argsPath, "utf8"), ...result };
    }
  );

describe("Production applied D1 migration check", () => {
  it("reads the Production Alchemy D1 resource and compares the remote ledger with checked-in SQL", async () => {
    const result = await runGate(validFixture);

    expect(result.exitCode).toBe(0);
    expect(result.output).toContain("Production D1 applied migration hashes match checked-in SQL.");
    expect(result.args).toContain(
      "state read FidyCloudflare/production/Database --backend cloudflare --profile ci --no-input --log-level error"
    );
    expect(result.args).toContain(
      "wrangler d1 execute FidyCloudflare-Database-production-test --remote --yes"
    );
    expect(result.args).toContain("FROM __alchemy_migrations ORDER BY id LIMIT 1001");
    expect(result.args).toContain("--json");
    expect(result.output).not.toContain("Refreshing Cloudflare State Store credentials");
    expect(result.output).not.toContain("local-only-migration-test-token");
  });

  it("blocks on any applied hash mismatch without printing provider output", async () => {
    const result = await runGate({
      ...validFixture,
      rows: [{ name: appliedName, hash: "0".repeat(64), ledger_count: 1 }],
    });

    expect(result.exitCode).toBe(1);
    expect(result.output).toContain(`hash differs from checked-in SQL: ${appliedName}`);
    expect(result.output).not.toContain("0".repeat(64));
  });

  it("fails closed when the Production state identifies a different migration ledger", async () => {
    const result = await runGate({
      ...validFixture,
      state: {
        attr: {
          databaseName: "FidyCloudflare-Database-production-test",
          migrationsTable: "d1_migrations",
        },
      },
    });

    expect(result.exitCode).toBe(1);
    expect(result.args).toContain("state read FidyCloudflare/production/Database");
    expect(result.args).not.toContain("wrangler d1 execute");
    expect(result.output).toContain(
      "could not be verified while attempting to read Alchemy's Production D1 resource state"
    );
    expect(result.output).toContain("deployment is blocked");
  });

  it("fails closed when the remote ledger query rejects or returns an incomplete history", async () => {
    const rejected = await runGate({ ...validFixture, wranglerExitCode: 1 });
    const incomplete = await runGate({
      ...validFixture,
      rows: [{ name: appliedName, hash: appliedHash, ledger_count: 2 }],
    });

    expect(rejected.exitCode).toBe(1);
    expect(incomplete.exitCode).toBe(1);
    expect(rejected.output).toContain(
      "could not be verified while attempting to query the Production D1 migration ledger"
    );
    expect(incomplete.output).toContain(
      "could not be verified while attempting to query the Production D1 migration ledger"
    );
    expect(rejected.output).toContain("deployment is blocked");
    expect(incomplete.output).toContain("deployment is blocked");
    expect(rejected.output).not.toContain("local-only-migration-test-token");
  });
});
