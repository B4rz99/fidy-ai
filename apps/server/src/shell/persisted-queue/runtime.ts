import { Layer } from "effect";
import type { SqlClient, SqlError } from "effect/unstable/sql";
import type { ApplicationPersistedQueueRequirement } from "./contract";
import {
  sqlStorage as privateSqlStorage,
  volatileStorage as privateVolatileStorage,
} from "~/shell/persisted-queue/internal/storage";

/**
 * Production SQL queue authority. Construction and the raw Effect factory stay private; runtime
 * composition receives only the application requirement used by declared queues. Suspended so the
 * published binding constructs its own layer instead of re-exporting the internal layer value.
 */
export const PersistedQueueSqlLive: Layer.Layer<
  ApplicationPersistedQueueRequirement,
  SqlError.SqlError,
  SqlClient.SqlClient
> = Layer.suspend(() => privateSqlStorage);

/** Volatile queue authority for tests that do not assert process-loss or cross-runtime behavior. */
export const VolatilePersistedQueue: Layer.Layer<ApplicationPersistedQueueRequirement> =
  Layer.suspend(() => privateVolatileStorage);
