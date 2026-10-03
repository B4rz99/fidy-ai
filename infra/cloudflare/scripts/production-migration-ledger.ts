import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import * as Schema from "effect/Schema";
import {
  type AppliedMigration,
  type MigrationSource,
  decodeWranglerMigrationRows,
  maximumAppliedMigrationRows,
} from "./migration-history";
import { runMigrationCommand } from "./run-migration-command";

const infrastructureDirectory = fileURLToPath(new URL("../", import.meta.url));
const migrationDirectory = fileURLToPath(
  new URL("../../../apps/server/cloudflare/migrations/", import.meta.url)
);
const statePath = "FidyCloudflare/production/Database";
const maximumDatabaseNameCharacters = 64;
const ledgerTable = "__alchemy_migrations";
const ledgerQuery =
  `SELECT name, hash, (SELECT COUNT(*) FROM ${ledgerTable}) AS ledger_count ` +
  `FROM ${ledgerTable} ORDER BY id LIMIT ${maximumAppliedMigrationRows + 1};`;

const DatabaseResourceState = Schema.Struct({
  attr: Schema.Struct({
    databaseName: Schema.String.check(
      Schema.isPattern(/^[A-Za-z0-9_-]+$/u),
      Schema.isMaxLength(maximumDatabaseNameCharacters)
    ),
    migrationsTable: Schema.Literal(ledgerTable),
  }),
});

const decodeProductionDatabaseName = (output: string): string => {
  const objectStarts = [...output.matchAll(/^\{/gmu)].map((match) => match.index);

  for (const index of objectStarts.reverse()) {
    try {
      return Schema.decodeUnknownSync(DatabaseResourceState)(JSON.parse(output.slice(index).trim()))
        .attr.databaseName;
    } catch {
      // Alchemy's non-interactive credential refresh can write progress before the JSON state.
      // Only a complete JSON object matching the expected resource schema is accepted.
    }
  }

  throw new Error("Alchemy Production D1 state output is invalid");
};

const runMigrationHistoryCommand = (command: readonly [string, ...Array<string>]): string =>
  runMigrationCommand(command, { cwd: infrastructureDirectory });

export const readProductionDatabaseName = (): string => {
  const profile = process.env.ALCHEMY_PROFILE;
  if (
    profile === undefined ||
    profile.length === 0 ||
    process.env.CLOUDFLARE_ACCOUNT_ID === undefined ||
    process.env.CLOUDFLARE_API_TOKEN === undefined
  ) {
    throw new Error("Production Cloudflare credentials are unavailable");
  }

  const output = runMigrationHistoryCommand([
    "bun",
    "../../node_modules/alchemy/bin/alchemy.js",
    "state",
    "read",
    statePath,
    "--backend",
    "cloudflare",
    "--profile",
    profile,
    "--no-input",
    "--log-level",
    "error",
  ]);
  return decodeProductionDatabaseName(output);
};

export const queryProductionMigrationLedger = (
  databaseName: string
): ReadonlyArray<AppliedMigration> => {
  const output = runMigrationHistoryCommand([
    "bun",
    "run",
    "wrangler",
    "d1",
    "execute",
    databaseName,
    "--remote",
    "--yes",
    "--command",
    ledgerQuery,
    "--json",
  ]);
  return decodeWranglerMigrationRows(output);
};

export const readProductionMigrationLedger = (): ReadonlyArray<AppliedMigration> =>
  queryProductionMigrationLedger(readProductionDatabaseName());

const collectSqlFiles = async (
  directory: string,
  prefix = ""
): Promise<ReadonlyArray<MigrationSource>> => {
  const entries = await readdir(directory, { withFileTypes: true });
  const files: ReadonlyArray<ReadonlyArray<MigrationSource>> = await Promise.all(
    entries.map(async (entry): Promise<ReadonlyArray<MigrationSource>> => {
      const name = prefix.length === 0 ? entry.name : `${prefix}/${entry.name}`;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) return collectSqlFiles(path, name);
      if (entry.isFile() && entry.name.endsWith(".sql")) {
        return [{ name, source: await readFile(path, "utf8") }];
      }
      return [];
    })
  );
  return files.flat();
};

export const readCheckedInMigrationSources = async (): Promise<ReadonlyArray<MigrationSource>> =>
  [...(await collectSqlFiles(migrationDirectory))].sort((left, right) =>
    left.name.localeCompare(right.name)
  );
