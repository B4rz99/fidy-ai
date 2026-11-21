import { Cause, Effect, Option, Schedule, Schema } from "effect";
import { gitRevisionPattern } from "../../apps/server/cloudflare/runtime/contract";
import { SmokeIdentity } from "../../apps/server/cloudflare/runtime/release-smoke/contract";

const logUnobservedDeployment = (error: Error): Effect.Effect<void> =>
  Effect.logWarning("Deployment observation failed", { reason: error.name });

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

export type StableRestoration = Readonly<{
  target: Readonly<{ name: string; stableVersionId: string; previous: Deployment }>;
  companion: Readonly<{ name: string; previous: Deployment }>;
}>;

export type ReleasePort = Readonly<{
  trunk(): Effect.Effect<string, Error>;
  current(name: string): Effect.Effect<Deployment, Error>;
  deploy(
    name: string,
    versions: ReadonlyArray<{ id: string; percentage: number }>
  ): Effect.Effect<Deployment, Error>;
  restoreStable?(input: StableRestoration): Effect.Effect<Deployment, Error>;
}>;

const servingVersion = Effect.fn(function* (deployment: Deployment) {
  const serving = deployment.versions.filter((version) => version.percentage !== 0);

  if (
    deployment.versions.length > 2 ||
    new Set(deployment.versions.map((version) => version.id)).size !== deployment.versions.length ||
    serving.length !== 1 ||
    serving[0]?.percentage !== 100
  ) {
    return yield* Effect.fail(Error("Worker does not have one sole 100% serving version"));
  }

  return serving[0].id;
});

const requireCapturedWorker = Effect.fn(function* (
  port: Pick<ReleasePort, "current">,
  snapshot: typeof WorkerSnapshot.Type
) {
  const current = yield* port.current(snapshot.name);
  const version = yield* servingVersion(current);

  if (current.id !== snapshot.deploymentId || version !== snapshot.stableVersionId) {
    return yield* Effect.fail(Error(`Worker deployment changed: ${snapshot.name}`));
  }
});

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
  input: { versions: Deployment["versions"]; previousId: string; readRetries: number }
) {
  return yield* Effect.gen(function* () {
    const observed = yield* port.current(name);

    if (observed.id === input.previousId || !matchesVersions(observed, input.versions)) {
      return yield* Effect.fail(Error("Worker write not confirmed; inspect deployment state"));
    }

    return observed;
  }).pipe(Effect.retry({ schedule: Schedule.spaced("500 millis"), times: input.readRetries }));
});

const deploymentReadRetries = 6;

const interruptedPromotionReadRetries = 24;

const deployObserved = Effect.fn(function* (
  port: ReleasePort,
  name: string,
  { versions, readRetries }: { versions: Deployment["versions"]; readRetries: number }
) {
  const previous = yield* port.current(name);

  const reported = yield* port.deploy(name, versions).pipe(
    Effect.catchCauseIf(
      (cause) => !Cause.hasInterrupts(cause),
      (writeCause) =>
        observeCommitted(port, name, { versions, previousId: previous.id, readRetries }).pipe(
          Effect.catchCause((observationCause) =>
            Effect.failCause(Cause.combine(observationCause, writeCause))
          )
        )
    )
  );

  const result =
    reported.id === previous.id
      ? yield* observeCommitted(port, name, { versions, previousId: previous.id, readRetries })
      : reported;

  yield* requireDeployment(port, name, { id: result.id, versions }).pipe(
    Effect.retry({ schedule: Schedule.spaced("500 millis"), times: readRetries })
  );

  return result;
});

const deployExact = (
  port: ReleasePort,
  name: string,
  versions: Deployment["versions"]
): ReturnType<typeof deployObserved> =>
  deployObserved(port, name, { versions, readRetries: deploymentReadRetries });

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
    const stableVersionId = yield* servingVersion(current);

    return { name, deploymentId: current.id, stableVersionId };
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
  yield* requireCapturedWorker(port, snapshot.public);
  yield* requireCapturedWorker(port, snapshot.core);

  const publicDeployment = yield* deployExact(
    port,
    snapshot.public.name,
    staged(snapshot.public, versions.publicVersionId, snapshot.public.deploymentId).versions
  );

  yield* requireTrunk(port, snapshot.revision);
  yield* requireCapturedWorker(port, snapshot.core);

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

const restoreCore = Effect.fn(function* (
  port: ReleasePort,
  input: { release: StagedRelease; publicStaged: Deployment; corePromoted: Deployment }
) {
  const { snapshot } = input.release;

  const observedPublic = yield* port
    .current(snapshot.public.name)
    .pipe(Effect.tapError(logUnobservedDeployment), Effect.option);

  const observedCore = yield* port
    .current(snapshot.core.name)
    .pipe(Effect.tapError(logUnobservedDeployment), Effect.option);

  if (
    Option.exists(observedPublic, (deployment) => deployment.id === input.publicStaged.id) &&
    Option.exists(observedCore, (deployment) => deployment.id === input.corePromoted.id)
  ) {
    const restoreStable = port.restoreStable;

    const restorationPort =
      restoreStable === undefined
        ? port
        : {
            ...port,
            deploy: (): Effect.Effect<Deployment, Error> =>
              restoreStable({
                target: {
                  name: snapshot.core.name,
                  stableVersionId: snapshot.core.stableVersionId,
                  previous: input.corePromoted,
                },
                companion: { name: snapshot.public.name, previous: input.publicStaged },
              }),
          };

    const restored = yield* deployExact(
      restorationPort,
      snapshot.core.name,
      stable(snapshot.core).versions
    ).pipe(Effect.isSuccess);

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
  const observedCore = Option.filter(
    yield* port.current(release.snapshot.core.name).pipe(Effect.option),
    (core) =>
      core.versions.length === 1 &&
      core.versions[0]?.id === release.coreVersionId &&
      core.versions[0].percentage === 100
  );

  if (Option.isNone(observedCore)) {
    return yield* Effect.fail(
      Error("Core promotion not confirmed; inspect both Worker deployments")
    );
  }

  return yield* restoreCore(port, { release, publicStaged, corePromoted: observedCore.value });
});

const promoteRelease = Effect.fn(function* (
  port: ReleasePort,
  release: StagedRelease,
  smoke: { exactPairPassed: boolean; middlePairPassed: boolean; rollbackEligible: boolean }
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
      () =>
        smoke.rollbackEligible
          ? restoreAmbiguousCore(port, release, publicStaged)
          : Effect.fail(Error("Core promotion uncertain; inspect and use forward repair"))
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
      () =>
        smoke.rollbackEligible
          ? restoreCore(port, { release, publicStaged, corePromoted })
          : Effect.fail(Error("Core advanced; preserve current stores and use forward repair"))
    )
  );

  return { publicDeploymentId: publicPromoted.id, coreDeploymentId: corePromoted.id };
});

const finishIngressPromotion = Effect.fn(function* (
  port: ReleasePort,
  release: StagedRelease,
  coreDeploymentId: string
) {
  const { snapshot } = release;
  yield* requireTrunk(port, snapshot.revision);
  yield* requireDeployment(port, snapshot.core.name, {
    id: coreDeploymentId,
    versions: [{ id: release.coreVersionId, percentage: 100 }],
  });

  const ingressStaged = staged(
    snapshot.public,
    release.publicVersionId,
    release.publicDeploymentId
  );

  yield* requireDeployment(port, snapshot.public.name, ingressStaged);

  const ingress = yield* deployObserved(port, snapshot.public.name, {
    versions: [{ id: release.publicVersionId, percentage: 100 }],
    readRetries: interruptedPromotionReadRetries,
  });

  return { publicDeploymentId: ingress.id, coreDeploymentId };
});

const isolateRelease = Effect.fn(function* (
  port: ReleasePort,
  snapshot: ReleaseSnapshot,
  input: {
    candidate: { publicVersionId: string; coreVersionId: string };
    expected: { publicVersionId: string; coreVersionId: string };
    proveIsolation: (publicVersionId: string) => Effect.Effect<void, Error>;
  }
) {
  const { candidate, expected, proveIsolation } = input;

  if (
    snapshot.public.stableVersionId !== expected.publicVersionId ||
    snapshot.core.stableVersionId !== expected.coreVersionId
  ) {
    return yield* Effect.fail(Error("Isolation baseline changed; traffic unchanged"));
  }

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
  requireTrunk,
  servingVersion,
  requireCapturedWorker,
  captureRelease,
  deployExact,
  stageRelease,
  promoteRelease,
  finishIngressPromotion,
  isolateRelease,
  verifyRetirement,
};
