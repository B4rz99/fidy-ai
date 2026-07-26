import { createTransactions } from "./0001-create-transactions";

/**
 * The explicit index ARCHITECTURE.md §7 calls for: one ordered, append-only
 * record naming every migration file, consumed by the Effect migrator. Keys
 * follow the `<id>_<name>` convention the migrator sorts by, and `fromRecord`
 * silently drops any key that does not match it.
 *
 * Not a barrel — it re-exports nothing and is the composition point itself.
 */
export const migrations = {
  "0001_create_transactions": createTransactions,
};
