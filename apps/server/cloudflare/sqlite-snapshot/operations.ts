import { retireArtifacts } from "./internal/retirement";
import { advance } from "./internal/builder";
import { artifactRead } from "./internal/artifact";
import { Effect } from "effect";
import {
  type ClosedSnapshotExport,
  type ClosedSnapshotSource,
  type SnapshotArtifact,
  type SnapshotArtifactRead,
  type SnapshotArtifactRetirementInput,
  type SnapshotArtifactRetirementStatus,
  type SnapshotBuildStatus,
  type SnapshotPageReceipt,
  SnapshotUnavailable,
} from "./contract";
import { exportTable } from "./internal/export";

/** Exports at most one retained row, with exact integer/blob cells, behind the independent closed-source barrier. Retrying the same frozen row is content-addressed and idempotent. */
export const exportClosedSnapshotTable = (
  input: ClosedSnapshotExport
): Effect.Effect<SnapshotPageReceipt, SnapshotUnavailable> =>
  exportTable(input).pipe(Effect.catchCause(() => Effect.fail(new SnapshotUnavailable())));

/** One bounded catalog or row step. Independent source evidence is pinned throughout; conditional checkpoints make lost replies resumable. Ready seals artifact content, never serving authority. */
export const advanceClosedSnapshot = (
  input: ClosedSnapshotSource
): Effect.Effect<SnapshotBuildStatus, SnapshotUnavailable> => advance(input);
/** Read one immutable bounded migration object by its expected content digest. No input establishes User or serving authority. */
export const readSnapshotArtifact = (
  input: SnapshotArtifactRead
): Effect.Effect<SnapshotArtifact, SnapshotUnavailable> => artifactRead(input);

/** Bounded temporary-artifact retirement after independently earned disposition; repeated invocations observe empty prefixes without trusting a deletion reply as qualification. */
export const retireSnapshotArtifacts = (
  input: SnapshotArtifactRetirementInput
): Effect.Effect<SnapshotArtifactRetirementStatus, SnapshotUnavailable> => retireArtifacts(input);
