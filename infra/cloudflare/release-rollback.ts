import { Data, Effect, Schedule, Schema } from "effect";
import { SmokeIdentity } from "../../apps/server/cloudflare/runtime/release-smoke/contract";
import {
  type Deployment,
  type ReleasePort,
  type StagedRelease,
  releaseSchemas,
} from "./release-controller";

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
type Traffic = Readonly<{ id: string; version: string }>;
const sameTraffic = (current: Deployment, expected: Traffic): boolean =>
  current.id === expected.id &&
  current.versions.length === 1 &&
  current.versions[0]?.id === expected.version &&
  current.versions[0].percentage === 100;
const requireTraffic = Effect.fn(function* (port: RollbackPort, name: string, expected: Traffic) {
  const current = yield* port.current(name);
  if (!sameTraffic(current, expected)) {
    return yield* Effect.fail(Error("Worker traffic changed; operator inspection required"));
  }
});
class RollbackObservationPending extends Data.TaggedError("RollbackObservationPending") {}
const routeStable = Effect.fn(function* (
  port: RollbackPort,
  name: string,
  { stableId, previous }: { stableId: string; previous: Traffic }
) {
  const result = yield* port
    .deploy(name, [{ id: stableId, percentage: 100 }])
    .pipe(
      Effect.tapCause(() => Effect.logError("Rollback write could not be confirmed for " + name))
    );
  const expected = { id: result.id, version: stableId };
  if (result.id === previous.id || !sameTraffic(result, expected)) {
    return yield* Effect.fail(
      Error("Rollback write receipt differs from the requested assignment")
    );
  }
  yield* Effect.gen(function* () {
    const current = yield* port.current(name);
    if (sameTraffic(current, expected)) return;
    if (sameTraffic(current, previous)) return yield* new RollbackObservationPending();
    return yield* Effect.fail(Error("Worker traffic changed after the rollback write"));
  }).pipe(
    Effect.retry({
      while: (error) => error instanceof RollbackObservationPending,
      times: 6,
      schedule: Schedule.spaced("500 millis"),
    }),
    Effect.tapCause(() =>
      Effect.logError("Accepted rollback assignment was not observed for " + name)
    )
  );
  return result;
});

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
  const publicBefore = {
    id: input.promoted.publicDeploymentId,
    version: input.release.publicVersionId,
  };
  const coreBefore = {
    id: input.promoted.coreDeploymentId,
    version: input.release.coreVersionId,
  };
  yield* requireTraffic(port, snapshot.public.name, publicBefore);
  yield* requireTraffic(port, snapshot.core.name, coreBefore);
  const restoredPublic = yield* routeStable(port, snapshot.public.name, {
    stableId: snapshot.public.stableVersionId,
    previous: publicBefore,
  });
  yield* requireTraffic(port, snapshot.public.name, {
    id: restoredPublic.id,
    version: snapshot.public.stableVersionId,
  });
  yield* requireTraffic(port, snapshot.core.name, coreBefore);
  return yield* routeStable(port, snapshot.core.name, {
    stableId: snapshot.core.stableVersionId,
    previous: coreBefore,
  });
});

export const releaseRollback = { restore, routeStable };
