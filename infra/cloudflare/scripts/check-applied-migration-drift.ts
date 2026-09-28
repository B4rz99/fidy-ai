#!/usr/bin/env bun

import * as BunCrypto from "@effect/platform-bun/BunCrypto";
import * as Effect from "effect/Effect";
import {
  type AppliedMigrationDrift,
  compareAppliedMigrationRows,
  hashMigrationSources,
} from "./migration-history";
import {
  readCheckedInMigrationSources,
  readProductionMigrationLedger,
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

const main = async (): Promise<void> => {
  try {
    const applied = readProductionMigrationLedger();
    const sources = await readCheckedInMigrationSources();
    const checkedIn = await Effect.runPromise(
      hashMigrationSources(sources).pipe(Effect.provide(BunCrypto.layer))
    );
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
      "Production D1 migration history could not be verified; deployment is blocked.\n"
    );
    process.exitCode = 1;
  }
};

await main();
