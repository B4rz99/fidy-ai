import { Effect, Schema } from "effect";
import { SmokeIdentity } from "../../apps/server/cloudflare/runtime/smoke";
import {
  type Deployment,
  type ReleasePort,
  type ReleaseSnapshot,
  releaseController,
} from "./release-controller";

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
    yield* releaseController.deployExact(port, name, [{ id: stableId, percentage: 100 }]);
  });
  yield* clean(snapshot.public.name, snapshot.public.stableVersionId, candidate.publicVersionId);
  yield* clean(snapshot.core.name, snapshot.core.stableVersionId, candidate.coreVersionId);
});
export const releaseCleanup = { cleanRelease };
