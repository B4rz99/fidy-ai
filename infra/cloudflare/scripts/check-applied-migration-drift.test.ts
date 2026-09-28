import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { withSubprocessTestFixture } from "./subprocess-test-fixture";

const scriptPath = fileURLToPath(new URL("./check-applied-migration-drift.ts", import.meta.url));
const infrastructureDirectory = fileURLToPath(new URL("../", import.meta.url));
const appliedName = "0001_categories.sql";
const appliedHash = "5c14f7a6901179f89f5ee798c2ff69c36873f2de52316a08478a1fbff92e2019";

type GateFixture = {
  readonly state: unknown;
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
      const rowsPath = join(temporaryDirectory, "rows.json");
      const fakeBun = join(fakeBin, "bun");

      await writeFile(statePath, JSON.stringify(fixture.state));
      await writeFile(
        rowsPath,
        JSON.stringify([
          {
            results: fixture.rows,
            success: true,
          },
        ])
      );
      await writeFile(
        fakeBun,
        [
          "#!/usr/bin/env bash",
          'printf "%s\\n" "$*" >> "$MIGRATION_COMMANDS"',
          'if [[ "$*" == *"alchemy.ts state read"* ]]; then',
          '  cat "$MIGRATION_STATE"',
          'elif [[ "$*" == *"run wrangler d1 execute"* ]]; then',
          '  cat "$MIGRATION_ROWS"',
          '  exit "${WRANGLER_EXIT_CODE:-0}"',
          "else",
          "  exit 97",
          "fi",
          "",
        ].join("\n"),
        { mode: 0o755 }
      );

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
      "state read FidyCloudflare/production/Database --backend cloudflare --profile ci --no-input"
    );
    expect(result.args).toContain(
      "wrangler d1 execute FidyCloudflare-Database-production-test --remote --yes"
    );
    expect(result.args).toContain("FROM __alchemy_migrations ORDER BY id LIMIT 1001");
    expect(result.args).toContain("--json");
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
    expect(result.output).toContain("could not be verified; deployment is blocked");
  });

  it("fails closed when the remote ledger query rejects or returns an incomplete history", async () => {
    const rejected = await runGate({ ...validFixture, wranglerExitCode: 1 });
    const incomplete = await runGate({
      ...validFixture,
      rows: [{ name: appliedName, hash: appliedHash, ledger_count: 2 }],
    });

    expect(rejected.exitCode).toBe(1);
    expect(incomplete.exitCode).toBe(1);
    expect(rejected.output).toContain("could not be verified; deployment is blocked");
    expect(incomplete.output).toContain("could not be verified; deployment is blocked");
    expect(rejected.output).not.toContain("local-only-migration-test-token");
  });
});
