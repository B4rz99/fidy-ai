import { Schema } from "effect";
import { SmokeIdentity } from "../../apps/server/cloudflare/runtime/smoke";
import { type Deployment, type ReleasePort, type ReleaseSnapshot } from "./release-controller";

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
export const cleanRelease = async (
  port: ReleasePort,
  snapshot: ReleaseSnapshot,
  candidate: { publicVersionId: string; coreVersionId: string }
): Promise<void> => {
  const verifyCandidate = Schema.decodeUnknownSync(SmokeIdentity.fields.workerVersionId);
  const clean = async (name: string, stableId: string, candidateId: string): Promise<void> => {
    const observed = await port.current(name);
    if (isStable(observed, stableId)) {
      return;
    }
    if (!isStaged(observed, stableId, verifyCandidate(candidateId))) {
      throw Error("Cannot clean an unexpected Worker deployment; operator inspection required");
    }
    const confirmed = await port.current(name);
    if (confirmed.id !== observed.id) {
      throw Error("Worker deployment changed during cleanup");
    }
    await port.deploy(name, [{ id: stableId, percentage: 100 }]);
    const restored = await port.current(name);
    if (!isStable(restored, stableId)) {
      throw Error("Stable Worker traffic restoration not confirmed");
    }
  };
  await clean(snapshot.public.name, snapshot.public.stableVersionId, candidate.publicVersionId);
  await clean(snapshot.core.name, snapshot.core.stableVersionId, candidate.coreVersionId);
};
