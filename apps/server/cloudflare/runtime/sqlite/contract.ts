/** Only owner-defined, versioned SQL can enter a store migration. */
export type MigrationStatement =
  | string
  | Readonly<{ sql: string; bindings: ReadonlyArray<string | number> }>;
export type StoreMigration = Readonly<{
  version: number;
  id: string;
  statements: ReadonlyArray<MigrationStatement>;
}>;
export type StoreHistory = Readonly<{
  owner: "user" | "directory" | "pricing" | "maintenance" | "erasure";
  steps: ReadonlyArray<StoreMigration>;
}>;
export type StoreReleaseEnvironment = Readonly<{ CF_VERSION_METADATA: Readonly<{ id: string }> }>;
