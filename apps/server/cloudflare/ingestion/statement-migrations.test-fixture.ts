import { Function } from "effect";
import { applyTestMigration } from "../d1-test-fixture";

const applyMigration = (db: D1Database, name: string): Promise<void> =>
  applyTestMigration({ db, source: new URL(`../migrations/${name}.sql`, import.meta.url) });

/** Apply a checked-in statement test migration to local D1 in statement order. */
export const applyStatementTestMigration: {
  (name: string): (db: D1Database) => Promise<void>;
  (db: D1Database, name: string): Promise<void>;
} = Function.dual(2, applyMigration);
