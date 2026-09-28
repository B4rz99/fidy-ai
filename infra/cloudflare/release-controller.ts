import { Cause, Effect, Schema } from "effect";
import { gitRevisionPattern } from "../../apps/server/cloudflare/runtime/release-identity";
import { SmokeIdentity } from "../../apps/server/cloudflare/runtime/smoke";

const VersionId = SmokeIdentity.fields.workerVersionId;
const Revision = Schema.String.check(Schema.isPattern(gitRevisionPattern));
const WorkerName = Schema.String.check(Schema.isPattern(/^[a-zA-Z0-9_-]{1,80}$/u));
const Deployment = Schema.Struct({
  id: VersionId,
  versions: Schema.Array(Schema.Struct({ id: VersionId, percentage: Schema.Finite })),
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
export const releaseSchemas = {
  snapshot: ReleaseSnapshotSchema,
  staged: StagedReleaseSchema,
};

/** Cloudflare routing is the only replaceable adapter; no product Worker or Alchemy resource is constructed here. */
export type ReleasePort = Readonly<{
  trunk(): Effect.Effect<string, Error>;
  current(name: string): Effect.Effect<Deployment, Error>;
  deploy(
    name: string,
    versions: ReadonlyArray<{ id: string; percentage: number }>
  ): Effect.Effect<Deployment, Error>;
}>;

const requireTrunk = Effect.fn(function* (port: ReleasePort, revision: string) {
  if ((yield* port.trunk()) !== revision) {
    return yield* Effect.fail(Error("Release superseded by trunk; traffic unchanged"));
  }
});
const requireDeployment = Effect.fn(function* (
  port: ReleasePort,
  name: string,
  expected: Deployment
) {
  const observed = yield* port.current(name);
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
    return yield* Effect.fail(Error(`Worker deployment changed: ${name}`));
  }
});
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
const deployExact = Effect.fn(function* (
  port: ReleasePort,
  name: string,
  versions: Deployment["versions"]
) {
  const result = yield* port.deploy(name, versions);
  yield* requireDeployment(port, name, { id: result.id, versions });
  return result;
});

/** Capture only unambiguous, fully stable Worker deployments before Alchemy changes anything. */
const captureRelease = Effect.fn(function* (
  port: ReleasePort,
  input: {
    revision: string;
    stableRevision: string;
    stableContractDigest: string;
    publicName: string;
    coreName: string;
  }
) {
  yield* requireTrunk(port, input.revision);
  const get = Effect.fn(function* (name: string) {
    const current = yield* port.current(name);
    if (current.versions.length !== 1 || current.versions[0]?.percentage !== 100) {
      return yield* Effect.fail(Error(`Worker is not fully stable: ${name}`));
    }
    return { name, deploymentId: current.id, stableVersionId: current.versions[0].id };
  });
  const publicWorker = yield* get(input.publicName);
  const coreWorker = yield* get(input.coreName);
  const snapshot = yield* Schema.decodeEffect(ReleaseSnapshotSchema)({
    revision: input.revision,
    stableRevision: input.stableRevision,
    stableContractDigest: input.stableContractDigest,
    public: publicWorker,
    core: coreWorker,
  });
  yield* requireTrunk(port, input.revision);
  return snapshot;
});

/** After Alchemy uploads, install the exact receipt IDs without giving them normal traffic. */
const stageRelease = Effect.fn(function* (
  port: ReleasePort,
  snapshot: ReleaseSnapshot,
  candidate: { publicVersionId: string; coreVersionId: string }
) {
  const versions = {
    publicVersionId: yield* Schema.decodeEffect(VersionId)(candidate.publicVersionId),
    coreVersionId: yield* Schema.decodeEffect(VersionId)(candidate.coreVersionId),
  };
  if (
    versions.publicVersionId === snapshot.public.stableVersionId ||
    versions.coreVersionId === snapshot.core.stableVersionId
  ) {
    return yield* Effect.fail(Error("Candidate upload did not produce new Worker versions"));
  }
  yield* requireTrunk(port, snapshot.revision);
  yield* requireDeployment(port, snapshot.public.name, stable(snapshot.public));
  yield* requireDeployment(port, snapshot.core.name, stable(snapshot.core));
  const publicDeployment = yield* deployExact(
    port,
    snapshot.public.name,
    staged(snapshot.public, versions.publicVersionId, snapshot.public.deploymentId).versions
  );
  yield* requireTrunk(port, snapshot.revision);
  yield* requireDeployment(port, snapshot.core.name, stable(snapshot.core));
  const coreDeployment = yield* deployExact(
    port,
    snapshot.core.name,
    staged(snapshot.core, versions.coreVersionId, snapshot.core.deploymentId).versions
  );
  return yield* Schema.decodeEffect(StagedReleaseSchema)({
    snapshot,
    ...versions,
    publicDeploymentId: publicDeployment.id,
    coreDeploymentId: coreDeployment.id,
  });
});

/** Called only after both smoke pairings pass. Core goes first; a failed second write is compensated when safe. */
const restoreCore = Effect.fn(function* (
  port: ReleasePort,
  input: { release: StagedRelease; publicStaged: Deployment; corePromoted: Deployment }
) {
  const { snapshot } = input.release;
  // An ambiguous Cloudflare failure could have committed. Never restore Core below new public code.
  const observedPublic = yield* port
    .current(snapshot.public.name)
    .pipe(Effect.catch(() => Effect.void));
  const observedCore = yield* port
    .current(snapshot.core.name)
    .pipe(Effect.catch(() => Effect.void));
  if (observedPublic?.id === input.publicStaged.id && observedCore?.id === input.corePromoted.id) {
    const restored = yield* deployExact(
      port,
      snapshot.core.name,
      stable(snapshot.core).versions
    ).pipe(
      Effect.match({
        onFailure: () => false,
        onSuccess: () => true,
      })
    );
    if (restored) {
      return yield* Effect.fail(
        Error("Public promotion failed; stable Core restored; release failed")
      );
    }
  }
  return yield* Effect.fail(
    Error(
      "Promotion incomplete; restoration not confirmed. Inspect both Worker deployments immediately"
    )
  );
});

const promoteRelease = Effect.fn(function* (
  port: ReleasePort,
  release: StagedRelease,
  smoke: { exactPairPassed: boolean; middlePairPassed: boolean }
) {
  if (!smoke.exactPairPassed || !smoke.middlePairPassed) {
    return yield* Effect.fail(Error("Release smoke or compatibility check failed"));
  }
  const { snapshot } = release;
  const publicStaged = staged(snapshot.public, release.publicVersionId, release.publicDeploymentId);
  const coreStaged = staged(snapshot.core, release.coreVersionId, release.coreDeploymentId);
  yield* requireTrunk(port, snapshot.revision);
  yield* requireDeployment(port, snapshot.public.name, publicStaged);
  yield* requireDeployment(port, snapshot.core.name, coreStaged);
  const corePromoted = yield* deployExact(port, snapshot.core.name, [
    { id: release.coreVersionId, percentage: 100 },
  ]);
  yield* Effect.gen(function* () {
    yield* requireTrunk(port, snapshot.revision);
    yield* requireDeployment(port, snapshot.public.name, publicStaged);
    yield* requireDeployment(port, snapshot.core.name, corePromoted);
    yield* deployExact(port, snapshot.public.name, [
      { id: release.publicVersionId, percentage: 100 },
    ]);
  }).pipe(
    Effect.catchCauseIf(
      (cause) => !Cause.hasInterrupts(cause),
      () => restoreCore(port, { release, publicStaged, corePromoted })
    )
  );
});

export const releaseController = { captureRelease, stageRelease, promoteRelease };
