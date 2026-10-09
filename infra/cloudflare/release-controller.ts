import { Cause, Effect, Schedule, Schema } from "effect";
import { gitRevisionPattern } from "../../apps/server/cloudflare/runtime/contract";
import { SmokeIdentity } from "../../apps/server/cloudflare/runtime/release-smoke/contract";

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
  if (observed.id !== expected.id || !matchesVersions(observed, expected.versions)) {
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
const matchesVersions = (observed: Deployment, versions: Deployment["versions"]): boolean =>
  observed.versions.length === versions.length &&
  versions.every((expected) =>
    observed.versions.some(
      (actual) => actual.id === expected.id && actual.percentage === expected.percentage
    )
  );

const observeCommitted = Effect.fn(function* (
  port: ReleasePort,
  name: string,
  input: { versions: Deployment["versions"]; previousId: string }
) {
  return yield* Effect.gen(function* () {
    const observed = yield* port.current(name);
    if (observed.id === input.previousId || !matchesVersions(observed, input.versions)) {
      return yield* Effect.fail(Error("Worker write not confirmed; inspect deployment state"));
    }
    return observed;
  }).pipe(Effect.retry({ schedule: Schedule.spaced("500 millis"), times: 6 }));
});

/** Write once and confirm exact routing, including when the accepted-write response was lost. */
const deployExact = Effect.fn(function* (
  port: ReleasePort,
  name: string,
  versions: Deployment["versions"]
) {
  const previous = yield* port.current(name);
  const reported = yield* port.deploy(name, versions).pipe(
    Effect.catchCauseIf(
      (cause) => !Cause.hasInterrupts(cause),
      (writeCause) =>
        observeCommitted(port, name, { versions, previousId: previous.id }).pipe(
          Effect.catchCause((observationCause) =>
            Effect.failCause(Cause.combine(observationCause, writeCause))
          )
        )
    )
  );
  // Wrangler's write adapter reads traffic after its command; that read can still be the old ID.
  const result =
    reported.id === previous.id
      ? yield* observeCommitted(port, name, { versions, previousId: previous.id })
      : reported;
  // Retry the read only; never repeat a traffic-changing request.
  yield* requireDeployment(port, name, { id: result.id, versions }).pipe(
    Effect.retry({ schedule: Schedule.spaced("500 millis"), times: 6 })
  );
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
  const { publicWorker, coreWorker } = yield* Effect.all(
    { publicWorker: get(input.publicName), coreWorker: get(input.coreName) },
    { concurrency: 2 }
  );
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

const restoreAmbiguousCore = Effect.fn(function* (
  port: ReleasePort,
  release: StagedRelease,
  publicStaged: Deployment
) {
  const observedCore = yield* port
    .current(release.snapshot.core.name)
    .pipe(Effect.catch(() => Effect.void));
  if (
    observedCore?.versions.length !== 1 ||
    observedCore.versions[0]?.id !== release.coreVersionId ||
    observedCore.versions[0].percentage !== 100
  ) {
    return yield* Effect.fail(
      Error("Core promotion not confirmed; inspect both Worker deployments")
    );
  }
  return yield* restoreCore(port, { release, publicStaged, corePromoted: observedCore });
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
  ]).pipe(
    Effect.catchCauseIf(
      (cause) => !Cause.hasInterrupts(cause),
      // A lost response or stale read can hide a committed Core write. Only restore
      // after observing exactly the tested middle pair; never overwrite an unknown pair.
      () => restoreAmbiguousCore(port, release, publicStaged)
    )
  );
  const publicPromoted = yield* Effect.gen(function* () {
    yield* requireTrunk(port, snapshot.revision);
    yield* requireDeployment(port, snapshot.public.name, publicStaged);
    yield* requireDeployment(port, snapshot.core.name, corePromoted);
    return yield* deployExact(port, snapshot.public.name, [
      { id: release.publicVersionId, percentage: 100 },
    ]);
  }).pipe(
    Effect.catchCauseIf(
      (cause) => !Cause.hasInterrupts(cause),
      () => restoreCore(port, { release, publicStaged, corePromoted })
    )
  );
  return { publicDeploymentId: publicPromoted.id, coreDeploymentId: corePromoted.id };
});

/** Incident recovery never retains the incompatible Core in a split or reopens public admission. */
const isolateRelease = Effect.fn(function* (
  port: ReleasePort,
  snapshot: ReleaseSnapshot,
  input: {
    candidate: { publicVersionId: string; coreVersionId: string };
    proveIsolation: (publicVersionId: string) => Effect.Effect<void, Error>;
  }
) {
  const { candidate, proveIsolation } = input;
  const publicVersionId = yield* Schema.decodeEffect(VersionId)(candidate.publicVersionId);
  const coreVersionId = yield* Schema.decodeEffect(VersionId)(candidate.coreVersionId);
  if (
    publicVersionId === snapshot.public.stableVersionId ||
    coreVersionId === snapshot.core.stableVersionId
  ) {
    return yield* Effect.fail(Error("Isolation requires newly uploaded Worker versions"));
  }
  yield* requireTrunk(port, snapshot.revision);
  yield* requireDeployment(port, snapshot.public.name, stable(snapshot.public));
  yield* requireDeployment(port, snapshot.core.name, stable(snapshot.core));
  const publicDeployment = yield* deployExact(port, snapshot.public.name, [
    { id: publicVersionId, percentage: 100 },
  ]);
  yield* proveIsolation(publicVersionId);
  yield* requireTrunk(port, snapshot.revision);
  yield* requireDeployment(port, snapshot.public.name, publicDeployment);
  yield* requireDeployment(port, snapshot.core.name, stable(snapshot.core));
  const coreDeployment = yield* deployExact(port, snapshot.core.name, [
    { id: coreVersionId, percentage: 100 },
  ]);
  yield* requireDeployment(port, snapshot.public.name, publicDeployment);
  return { publicVersionId, coreVersionId, publicDeployment, coreDeployment };
});

/** Cleanup is allowed only for the exact pair already promoted by this release. */
const verifyRetirement = Effect.fn(function* (
  port: ReleasePort,
  input: {
    release: StagedRelease;
    promoted: { publicDeploymentId: string; coreDeploymentId: string };
  }
) {
  const { release, promoted } = input;
  yield* requireTrunk(port, release.snapshot.revision);
  yield* requireDeployment(port, release.snapshot.public.name, {
    id: promoted.publicDeploymentId,
    versions: [{ id: release.publicVersionId, percentage: 100 }],
  });
  yield* requireDeployment(port, release.snapshot.core.name, {
    id: promoted.coreDeploymentId,
    versions: [{ id: release.coreVersionId, percentage: 100 }],
  });
});

export const releaseController = {
  captureRelease,
  deployExact,
  stageRelease,
  promoteRelease,
  isolateRelease,
  verifyRetirement,
};
