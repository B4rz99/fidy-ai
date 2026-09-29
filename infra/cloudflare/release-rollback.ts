import { Effect, Schema } from "effect";
import { SmokeIdentity } from "../../apps/server/cloudflare/runtime/smoke";
import { type ReleasePort, type StagedRelease, releaseSchemas } from "./release-controller";

export const RollbackReceipt = Schema.Struct({
  release: releaseSchemas.staged,
  promoted: Schema.Struct({
    publicDeploymentId: SmokeIdentity.fields.workerVersionId,
    coreDeploymentId: SmokeIdentity.fields.workerVersionId,
  }),
});

export type RollbackPort = ReleasePort &
  Readonly<{
    /** True only when Cloudflare lists this exact captured version as deployable. */
    deployable(name: string, versionId: string): Effect.Effect<boolean, Error>;
  }>;

type PromotedDeployments = typeof RollbackReceipt.Type.promoted;
const requireTraffic = Effect.fn(function* (
  port: RollbackPort,
  name: string,
  expected: Readonly<{ id: string; version: string }>
) {
  const current = yield* port.current(name);
  if (
    current.id !== expected.id ||
    current.versions.length !== 1 ||
    current.versions[0]?.id !== expected.version ||
    current.versions[0].percentage !== 100
  ) {
    return yield* Effect.fail(Error("Worker traffic changed; operator inspection required"));
  }
});
const routeStable = Effect.fn(function* (port: RollbackPort, name: string, stableId: string) {
  const result = yield* port.deploy(name, [{ id: stableId, percentage: 100 }]);
  yield* requireTraffic(port, name, { id: result.id, version: stableId });
  return result;
});

/** Restore only code traffic for the captured pair; refuse unknown compatibility or racing deployments. */
const restore = Effect.fn(function* (
  port: RollbackPort,
  input: Readonly<{
    release: StagedRelease;
    promoted: PromotedDeployments;
    compatible: boolean;
  }>
) {
  const { snapshot } = input.release;
  if (!input.compatible) {
    return yield* Effect.fail(
      Error("Rollback compatibility unproved; operator inspection required")
    );
  }
  if (
    !(yield* port.deployable(snapshot.public.name, snapshot.public.stableVersionId)) ||
    !(yield* port.deployable(snapshot.core.name, snapshot.core.stableVersionId))
  ) {
    return yield* Effect.fail(Error("Captured stable Worker version is not deployable"));
  }
  yield* requireTraffic(port, snapshot.public.name, {
    id: input.promoted.publicDeploymentId,
    version: input.release.publicVersionId,
  });
  yield* requireTraffic(port, snapshot.core.name, {
    id: input.promoted.coreDeploymentId,
    version: input.release.coreVersionId,
  });
  const restoredPublic = yield* routeStable(
    port,
    snapshot.public.name,
    snapshot.public.stableVersionId
  );
  yield* requireTraffic(port, snapshot.public.name, {
    id: restoredPublic.id,
    version: snapshot.public.stableVersionId,
  });
  yield* requireTraffic(port, snapshot.core.name, {
    id: input.promoted.coreDeploymentId,
    version: input.release.coreVersionId,
  });
  return yield* routeStable(port, snapshot.core.name, snapshot.core.stableVersionId);
});

export const releaseRollback = { restore };
