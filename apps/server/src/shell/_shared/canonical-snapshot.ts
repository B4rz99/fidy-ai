import { Effect } from "effect";
import { SqlError } from "effect/unstable/sql";
import { CanonicalOperationId } from "~/core/audit/model";

const snapshotRetryLimit = 2;
const coherentSnapshotOperations = new Set<CanonicalOperationId>([
  CanonicalOperationId.make("dashboard.getDashboardView"),
  CanonicalOperationId.make("operations.executeAtomicBatch"),
]);

const isSnapshotSerialization = (error: unknown): error is SqlError.SqlError =>
  SqlError.isSqlError(error) && error.reason._tag === "SerializationError";

const recoverSnapshotDefect = (defect: unknown): Effect.Effect<never, SqlError.SqlError> =>
  isSnapshotSerialization(defect) ? Effect.fail(defect) : Effect.die(defect);

/** Whether one canonical call requires a repeatable PostgreSQL snapshot across its statements. */
export const requiresCanonicalSnapshot = (operation: CanonicalOperationId): boolean =>
  coherentSnapshotOperations.has(operation);

/** Transaction isolation required before executing one canonical call. */
export const canonicalTransactionIsolation = (
  operation: CanonicalOperationId
): "read-committed" | "repeatable-read" =>
  requiresCanonicalSnapshot(operation) ? "repeatable-read" : "read-committed";

/** Retries a complete coherent call after PostgreSQL invalidates its repeatable-read snapshot. */
export const retryCanonicalSnapshot = <A, E, R>({
  operation,
  effect,
}: Readonly<{
  operation: CanonicalOperationId;
  effect: Effect.Effect<A, E, R>;
}>): Effect.Effect<A, E, R> =>
  requiresCanonicalSnapshot(operation)
    ? effect.pipe(
        Effect.catchDefect(recoverSnapshotDefect),
        Effect.retry({ times: snapshotRetryLimit, while: isSnapshotSerialization }),
        Effect.catchTag("SqlError", Effect.die)
      )
    : effect;
