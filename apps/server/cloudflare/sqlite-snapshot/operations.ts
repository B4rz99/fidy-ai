import { Effect } from "effect";
import {
  type ClosedSnapshotExport,
  type SnapshotPageReceipt,
  SnapshotUnavailable,
} from "./contract";
import { exportTable } from "./internal/export";

/** Exports at most one retained row, with exact integer/blob cells, behind the independent closed-source barrier. Retrying the same frozen row is content-addressed and idempotent. */
export const exportClosedSnapshotTable = (
  input: ClosedSnapshotExport
): Effect.Effect<SnapshotPageReceipt, SnapshotUnavailable> =>
  exportTable(input).pipe(Effect.catchCause(() => Effect.fail(new SnapshotUnavailable())));
