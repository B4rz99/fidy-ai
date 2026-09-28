import { Schema } from "effect";
import { gitRevisionPattern } from "../../apps/server/cloudflare/runtime/release-identity";
import { SmokeIdentity } from "../../apps/server/cloudflare/runtime/smoke";

const VersionId = SmokeIdentity.fields.workerVersionId;
const Revision = Schema.String.check(Schema.isPattern(gitRevisionPattern));
const WorkerName = Schema.String.check(Schema.isPattern(/^[a-zA-Z0-9_-]{1,80}$/u));
const Deployment = Schema.Struct({
  id: VersionId,
  versions: Schema.Array(Schema.Struct({ id: VersionId, percentage: Schema.Number })),
});
export type Deployment = typeof Deployment.Type;
const WorkerSnapshot = Schema.Struct({
  name: WorkerName,
  deploymentId: VersionId,
  stableVersionId: VersionId,
});
const ReleaseSnapshotSchema = Schema.Struct({
  revision: Revision,
  stableRevision: Revision,
  stableContractDigest: SmokeIdentity.fields.contractDigest,
  public: WorkerSnapshot,
  core: WorkerSnapshot,
});
export type ReleaseSnapshot = typeof ReleaseSnapshotSchema.Type;
const StagedReleaseSchema = Schema.Struct({
  snapshot: ReleaseSnapshotSchema,
  publicVersionId: VersionId,
  coreVersionId: VersionId,
  publicDeploymentId: VersionId,
  coreDeploymentId: VersionId,
});
export type StagedRelease = typeof StagedReleaseSchema.Type;
export const decodeSnapshot = Schema.decodeUnknownSync(ReleaseSnapshotSchema);
export const decodeStaged = Schema.decodeUnknownSync(StagedReleaseSchema);

/** Cloudflare routing is the only replaceable adapter; no product Worker or Alchemy resource is constructed here. */
export type ReleasePort = Readonly<{
  trunk(): Promise<string>;
  current(name: string): Promise<Deployment>;
  deploy(
    name: string,
    versions: ReadonlyArray<{ id: string; percentage: number }>
  ): Promise<Deployment>;
}>;

const requireTrunk = async (port: ReleasePort, revision: string): Promise<void> => {
  if ((await port.trunk()) !== revision) {
    throw Error("Release superseded by trunk; traffic unchanged");
  }
};
const requireDeployment = async (
  port: ReleasePort,
  name: string,
  expected: Deployment
): Promise<void> => {
  const observed = await port.current(name);
  if (
    observed.id !== expected.id ||
    observed.versions.length !== expected.versions.length ||
    expected.versions.some(
      (version) =>
        !observed.versions.some(
          (actual) => actual.id === version.id && actual.percentage === version.percentage
        )
    )
  ) {
    throw Error(`Worker deployment changed: ${name}`);
  }
};
const stable = (snapshot: typeof WorkerSnapshot.Type): Deployment => ({
  id: snapshot.deploymentId,
  versions: [{ id: snapshot.stableVersionId, percentage: 100 }],
});
const staged = (
  snapshot: typeof WorkerSnapshot.Type,
  candidate: string,
  deploymentId: string
): Deployment => ({
  id: deploymentId,
  versions: [
    { id: snapshot.stableVersionId, percentage: 100 },
    { id: candidate, percentage: 0 },
  ],
});
const deployExact = async (
  port: ReleasePort,
  name: string,
  versions: Deployment["versions"]
): Promise<Deployment> => {
  const result = await port.deploy(name, versions);
  await requireDeployment(port, name, { id: result.id, versions });
  return result;
};

/** Capture only unambiguous, fully stable Worker deployments before Alchemy changes anything. */
export const captureRelease = async (
  port: ReleasePort,
  input: {
    revision: string;
    stableRevision: string;
    stableContractDigest: string;
    publicName: string;
    coreName: string;
  }
): Promise<ReleaseSnapshot> => {
  await requireTrunk(port, input.revision);
  const get = async (name: string): Promise<typeof WorkerSnapshot.Type> => {
    const current = await port.current(name);
    if (current.versions.length !== 1 || current.versions[0]?.percentage !== 100) {
      throw Error(`Worker is not fully stable: ${name}`);
    }
    return { name, deploymentId: current.id, stableVersionId: current.versions[0].id };
  };
  const snapshot = decodeSnapshot({
    revision: input.revision,
    stableRevision: input.stableRevision,
    stableContractDigest: input.stableContractDigest,
    public: await get(input.publicName),
    core: await get(input.coreName),
  });
  await requireTrunk(port, input.revision);
  return snapshot;
};

/** After Alchemy uploads, install the exact receipt IDs without giving them normal traffic. */
export const stageRelease = async (
  port: ReleasePort,
  snapshot: ReleaseSnapshot,
  candidate: { publicVersionId: string; coreVersionId: string }
): Promise<StagedRelease> => {
  const versions = {
    publicVersionId: Schema.decodeUnknownSync(VersionId)(candidate.publicVersionId),
    coreVersionId: Schema.decodeUnknownSync(VersionId)(candidate.coreVersionId),
  };
  if (
    versions.publicVersionId === snapshot.public.stableVersionId ||
    versions.coreVersionId === snapshot.core.stableVersionId
  ) {
    throw Error("Candidate upload did not produce new Worker versions");
  }
  await requireTrunk(port, snapshot.revision);
  await requireDeployment(port, snapshot.public.name, stable(snapshot.public));
  await requireDeployment(port, snapshot.core.name, stable(snapshot.core));
  const publicDeployment = await deployExact(
    port,
    snapshot.public.name,
    staged(snapshot.public, versions.publicVersionId, snapshot.public.deploymentId).versions
  );
  await requireTrunk(port, snapshot.revision);
  await requireDeployment(port, snapshot.core.name, stable(snapshot.core));
  const coreDeployment = await deployExact(
    port,
    snapshot.core.name,
    staged(snapshot.core, versions.coreVersionId, snapshot.core.deploymentId).versions
  );
  return decodeStaged({
    snapshot,
    ...versions,
    publicDeploymentId: publicDeployment.id,
    coreDeploymentId: coreDeployment.id,
  });
};

/** Called only after both smoke pairings pass. Core goes first; a failed second write is compensated when safe. */
const restoreCore = async (
  port: ReleasePort,
  input: { release: StagedRelease; publicStaged: Deployment; corePromoted: Deployment }
): Promise<never> => {
  const { snapshot } = input.release;
  // An ambiguous Cloudflare failure could have committed. Never restore Core below new public code.
  const observedPublic = await port.current(snapshot.public.name).catch(() => undefined);
  const observedCore = await port.current(snapshot.core.name).catch(() => undefined);
  if (observedPublic?.id === input.publicStaged.id && observedCore?.id === input.corePromoted.id) {
    try {
      await deployExact(port, snapshot.core.name, stable(snapshot.core).versions);
    } catch {
      throw Error(
        "Promotion incomplete; restoration not confirmed. Inspect both Worker deployments immediately"
      );
    }
    throw Error("Public promotion failed; stable Core restored; release failed");
  }
  throw Error(
    "Promotion incomplete; restoration not confirmed. Inspect both Worker deployments immediately"
  );
};

export const promoteRelease = async (
  port: ReleasePort,
  release: StagedRelease,
  smoke: { exactPairPassed: boolean; middlePairPassed: boolean }
): Promise<void> => {
  if (!smoke.exactPairPassed || !smoke.middlePairPassed) {
    throw Error("Release smoke or compatibility check failed");
  }
  const { snapshot } = release;
  const publicStaged = staged(snapshot.public, release.publicVersionId, release.publicDeploymentId);
  const coreStaged = staged(snapshot.core, release.coreVersionId, release.coreDeploymentId);
  await requireTrunk(port, snapshot.revision);
  await requireDeployment(port, snapshot.public.name, publicStaged);
  await requireDeployment(port, snapshot.core.name, coreStaged);
  const corePromoted = await deployExact(port, snapshot.core.name, [
    { id: release.coreVersionId, percentage: 100 },
  ]);
  try {
    await requireTrunk(port, snapshot.revision);
    await requireDeployment(port, snapshot.public.name, publicStaged);
    await requireDeployment(port, snapshot.core.name, corePromoted);
    await deployExact(port, snapshot.public.name, [
      { id: release.publicVersionId, percentage: 100 },
    ]);
  } catch {
    return restoreCore(port, { release, publicStaged, corePromoted });
  }
};
