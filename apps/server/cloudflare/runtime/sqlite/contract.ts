import { Context, Data, type Effect } from "effect";

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
export type StoreReleaseEnvironment = Readonly<{
  CF_VERSION_METADATA: Readonly<{ id: string }>;
  SQLITE_STORE_CAPACITY_BYTES: string;
}>;
export type StoreCapacityEvidence = Readonly<{
  owner: StoreHistory["owner"];
  bytes: number;
  ceilingBytes: number;
  band: "normal" | "warning" | "restricted";
}>;
export class StoreCapacityUnavailable extends Data.TaggedError("StoreCapacityUnavailable") {}
export class StoreCapacity extends Context.Service<
  StoreCapacity,
  {
    readonly measure: Effect.Effect<StoreCapacityEvidence, StoreCapacityUnavailable>;
    readonly observe: Effect.Effect<StoreCapacityEvidence, StoreCapacityUnavailable>;
  }
>()("@fidy/server/cloudflare/runtime/sqlite/contract/StoreCapacity") {}

/** Only the Core holder of a shared namespace can ask its singleton for retained migration markers. */
export const storeReadinessUrl = "https://store.invalid/release-readiness";

/** Cannot equal a canonical UUID UserId. This named schema probe holds no User authority. */
export const releaseProbeName = "release-schema-probe-v1";
