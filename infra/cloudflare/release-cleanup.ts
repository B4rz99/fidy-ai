import { Data, Effect, Schedule, Schema } from "effect";
import { SmokeIdentity } from "../../apps/server/cloudflare/runtime/smoke";
import { type Deployment, type ReleasePort, type ReleaseSnapshot } from "./release-controller";

class CleanupPending extends Data.TaggedError("CleanupPending") {}

const isStable = (deployment: Deployment, stableId: string): boolean =>
  deployment.versions.length === 1 &&
  deployment.versions[0]?.id === stableId &&
  deployment.versions[0].percentage === 100;
const isStaged = (deployment: Deployment, stableId: string, candidateId: string): boolean => {
  const expected = [
    { id: stableId, percentage: 100 },
    { id: candidateId, percentage: 0 },
  ];
  return (
    deployment.versions.length === expected.length &&
    expected.every((version) =>
      deployment.versions.some(
        (item) => item.id === version.id && item.percentage === version.percentage
      )
    )
  );
};

/** Remove only this run's 0%-traffic candidates, never another release's versions. */
const cleanRelease = Effect.fn(function* (
  port: ReleasePort,
  snapshot: ReleaseSnapshot,
  candidate: { publicVersionId: string; coreVersionId: string }
) {
  const clean = Effect.fn(function* (name: string, stableId: string, candidateId: string) {
    const observed = yield* port.current(name);
    if (isStable(observed, stableId)) {
      return;
    }
    const verified = yield* Schema.decodeEffect(SmokeIdentity.fields.workerVersionId)(candidateId);
    if (!isStaged(observed, stableId, verified)) {
      return yield* Effect.fail(
        Error("Cannot clean an unexpected Worker deployment; operator inspection required")
      );
    }
    const confirmed = yield* port.current(name);
    if (confirmed.id !== observed.id) {
      return yield* Effect.fail(Error("Worker deployment changed during cleanup"));
    }
    const written = yield* port.deploy(name, [{ id: stableId, percentage: 100 }]);
    // Poll only the read. A stale response cannot justify repeating an accepted write.
    yield* Effect.gen(function* () {
      const restored = yield* port.current(name);
      if (restored.id === observed.id && isStaged(restored, stableId, verified)) {
        return yield* new CleanupPending();
      }
      if (restored.id !== written.id || !isStable(restored, stableId)) {
        return yield* Effect.fail(Error("Stable Worker traffic restoration not confirmed"));
      }
    }).pipe(
      Effect.retry({
        times: 6,
        schedule: Schedule.spaced("500 millis"),
        while: (error) => error instanceof CleanupPending,
      })
    );
  });
  yield* clean(snapshot.public.name, snapshot.public.stableVersionId, candidate.publicVersionId);
  yield* clean(snapshot.core.name, snapshot.core.stableVersionId, candidate.coreVersionId);
});
export const releaseCleanup = { cleanRelease };
