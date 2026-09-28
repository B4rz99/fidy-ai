#!/usr/bin/env bun

import * as BunCrypto from "@effect/platform-bun/BunCrypto";
import * as Effect from "effect/Effect";
import {
  type AppliedMigrationDrift,
  compareAppliedMigrationRows,
  hashMigrationSources,
} from "./migration-history";
import {
  queryProductionMigrationLedger,
  readCheckedInMigrationSources,
  readProductionDatabaseName,
} from "./production-migration-ledger";

const driftDescription = (drift: AppliedMigrationDrift): string => {
  switch (drift._tag) {
    case "DuplicateAppliedName":
      return `duplicate applied migration name ${drift.name}`;
    case "MissingSourceFile":
      return `applied migration file is missing: ${drift.name}`;
    case "HashMismatch":
      return `applied migration hash differs from checked-in SQL: ${drift.name}`;
  }
};

type FailureStage =
  | "read Alchemy's Production D1 resource state"
  | "query the Production D1 migration ledger"
  | "read checked-in D1 migration SQL"
  | "hash checked-in D1 migration SQL"
  | "compare applied migration history";

const main = async (): Promise<void> => {
  let failureStage: FailureStage = "read Alchemy's Production D1 resource state";
  try {
    const databaseName = readProductionDatabaseName();
    failureStage = "query the Production D1 migration ledger";
    const applied = queryProductionMigrationLedger(databaseName);
    failureStage = "read checked-in D1 migration SQL";
    const sources = await readCheckedInMigrationSources();
    failureStage = "hash checked-in D1 migration SQL";
    const checkedIn = await Effect.runPromise(
      hashMigrationSources(sources).pipe(Effect.provide(BunCrypto.layer))
    );
    failureStage = "compare applied migration history";
    const drift = Effect.runSync(compareAppliedMigrationRows(applied, checkedIn));
    if (drift.length > 0) {
      for (const violation of drift) {
        process.stderr.write(`Production D1 migration drift: ${driftDescription(violation)}.\n`);
      }
      process.exitCode = 1;
      return;
    }

    process.stdout.write("Production D1 applied migration hashes match checked-in SQL.\n");
  } catch {
    process.stderr.write(
      `Production D1 migration history could not be verified while attempting to ${failureStage}; deployment is blocked.\n`
    );
    process.exitCode = 1;
  }
};

await main();
