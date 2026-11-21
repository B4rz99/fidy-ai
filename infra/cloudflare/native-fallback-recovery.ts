import uploadedPair from "./native-pairing-upload.json" with { type: "json" };
import { isDeepStrictEqual } from "node:util";
import { Effect, Array as EffectArray, Option, Schema } from "effect";
import { gitRevisionPattern } from "../../apps/server/cloudflare/runtime/contract";
import { SmokeIdentity } from "../../apps/server/cloudflare/runtime/release-smoke/contract";
import { type RollbackPort, RollbackReceipt, releaseRollback } from "./release-rollback";
import {
  type Deployment,
  type ReleasePort,
  releaseController,
  releaseSchemas,
} from "./release-controller";

const Revision = Schema.String.check(Schema.isPattern(gitRevisionPattern));

export const archivedDormant = {
  revision: "b85bfb06ab573259c250231623b77b0f65e2ae5c",
  publicVersionId: "9937b1c5-bdc2-43eb-9cb4-3e65af4e00ab",
  publicDeploymentId: "61dc398a-e734-4ca1-9de6-786d37e2e9d1",
  coreVersionId: "0421da6d-3cf8-4e99-a538-52b2b5c47ca2",
  coreDeploymentId: "d392e5c1-c447-4484-8d94-bb6c5371603e",
  original: {
    core: "0b77e855-8813-4ff6-972f-63d2cc389b80",
    public: "d0058241-f258-4708-805c-ecba0cdd5d7c",
  },
  smoke: {
    deploymentId: "9994372a-6408-47ae-8706-88f1a949b571",
    versionId: "87f4baef-8e77-4093-86d0-cd075cf62601",
  },
} as const;

const archivedPairing = {
  revision: uploadedPair.revision,
  publicVersionId: uploadedPair.publicVersionId,
  coreVersionId: uploadedPair.coreVersionId,
  publicDeploymentId: uploadedPair.failedStage.publicDeploymentId,
  coreDeploymentId: uploadedPair.failedStage.coreDeploymentId,
};

const Namespace = Schema.String.check(Schema.isPattern(/^[a-f0-9]{32}$/u));

const Version = SmokeIdentity.fields.workerVersionId;

export const FallbackStage = Schema.Struct({
  revision: Revision,
  stableRevision: Revision,
  release: releaseSchemas.staged,
  smoke: Schema.Struct({ deploymentId: Version, versionId: Version }),
  provider: Schema.Struct({ revision: Revision, deploymentId: Version, versionId: Version }),
  namespaces: Schema.Struct({
    user: Namespace,
    directory: Namespace,
    pricing: Namespace,
    maintenance: Namespace,
    erasure: Namespace,
  }),
  controlsDigest: SmokeIdentity.fields.contractDigest,
});

export type FallbackStage = typeof FallbackStage.Type;

export type FallbackRepairPort = ReleasePort &
  Readonly<{
    recentDeployments(name: string): Effect.Effect<ReadonlyArray<Deployment>, Error>;
  }>;

const fixedCoordinates = ({
  revision,
  stableRevision,
  release,
  namespaces,
}: FallbackStage): boolean =>
  revision === release.snapshot.revision &&
  stableRevision === release.snapshot.stableRevision &&
  revision !== stableRevision &&
  release.snapshot.core.name === "fidy-native-storage-core" &&
  release.snapshot.public.name === "fidy-native-storage-ingress" &&
  release.coreVersionId !== release.snapshot.core.stableVersionId &&
  release.publicVersionId !== release.snapshot.public.stableVersionId &&
  new Set(Object.values(namespaces)).size === Object.keys(namespaces).length;

type Role = "core" | "public";

type Release = FallbackStage["release"];

type Position = Readonly<{ id: string; serving: boolean }>;

type Pair = Readonly<Record<Role, Position>>;

const hasZeroCandidate = (deployment: Deployment, stable: string, candidate: string): boolean =>
  deployment.versions.length === 2 &&
  deployment.versions.some((row) => row.id === candidate && row.percentage === 0) &&
  deployment.versions.some((row) => row.id === stable && row.percentage === 100);

const matchesStage = (deployment: Deployment, release: Release, role: Role): boolean =>
  deployment.id === release[`${role}DeploymentId`] &&
  hasZeroCandidate(deployment, release.snapshot[role].stableVersionId, release[`${role}VersionId`]);

const soleDeployment = (id: string, version: string): Deployment => ({
  id,
  versions: [{ id: version, percentage: 100 }],
});

export const RestoredDormantSource = Schema.Struct({
  receipt: RollbackReceipt,
  restored: RollbackReceipt.fields.promoted,
});

export const requireRestoredDormantSource = Effect.fn(function* ({
  port,
  snapshot,
  sealed,
  source,
}: {
  port: FallbackRepairPort;
  snapshot: Release["snapshot"];
  sealed: Release;
  source: typeof RestoredDormantSource.Type;
}) {
  const { release, promoted } = source.receipt;
  yield* releaseController.requireTrunk(port, snapshot.revision);

  yield* Effect.forEach(
    ["core", "public"] as const,
    Effect.fnUntraced(function* (role) {
      const captured = snapshot[role];
      const stable = release.snapshot[role];
      const deployment = `${role}DeploymentId` as const;
      const version = `${role}VersionId` as const;
      const history = yield* port.recentDeployments(captured.name);

      const expected = [
        soleDeployment(source.restored[deployment], sealed[version]),
        soleDeployment(promoted[deployment], release[version]),
        soleDeployment(stable.deploymentId, sealed[version]),
      ];

      if (
        !isDeepStrictEqual(captured, { ...stable, deploymentId: source.restored[deployment] }) ||
        !isDeepStrictEqual([history[0], history[1], history[3]], expected) ||
        !Option.exists(EffectArray.get(history, 2), (staged) =>
          matchesStage(staged, release, role)
        ) ||
        !Option.exists(EffectArray.get(history, 4), (staged) => matchesStage(staged, sealed, role))
      ) {
        return yield* Effect.fail(
          Error("Dormant rollback history differs from the protected restoration")
        );
      }
    }),
    { discard: true }
  );
});

type PartialRollback = {
  receipt: typeof RollbackReceipt.Type;
  ingressDeploymentId: string;
};

const requireRestoredIngress = Effect.fn(function* (
  port: FallbackRepairPort,
  { receipt, ingressDeploymentId }: PartialRollback
) {
  const { release, promoted } = receipt;
  const ingress = release.snapshot.public;
  const history = yield* port.recentDeployments(ingress.name);

  if (
    !isDeepStrictEqual(history[0], soleDeployment(ingressDeploymentId, ingress.stableVersionId)) ||
    !isDeepStrictEqual(
      history[1],
      soleDeployment(promoted.publicDeploymentId, release.publicVersionId)
    ) ||
    !Option.exists(EffectArray.get(history, 2), (staged) => matchesStage(staged, release, "public"))
  ) {
    return yield* Effect.fail(
      Error("Rollback Ingress history differs from the protected intermediate")
    );
  }
});

const coreRollbackPosition = Effect.fn(function* (
  port: FallbackRepairPort,
  { release, promoted }: typeof RollbackReceipt.Type
) {
  const core = release.snapshot.core;
  const history = yield* port.recentDeployments(core.name);
  const promotedCore = soleDeployment(promoted.coreDeploymentId, release.coreVersionId);

  const atPromotion = (index: number): boolean =>
    isDeepStrictEqual(history[index], promotedCore) &&
    Option.exists(EffectArray.get(history, index + 1), (staged) =>
      matchesStage(staged, release, "core")
    );

  if (atPromotion(0)) return Option.none<Deployment>();
  const [latest] = history;

  if (
    latest !== undefined &&
    atPromotion(1) &&
    ![release.coreDeploymentId, promoted.coreDeploymentId].includes(latest.id) &&
    isDeepStrictEqual(latest, soleDeployment(latest.id, core.stableVersionId))
  ) {
    return Option.some(latest);
  }

  return yield* Effect.fail(Error("Rollback Core history differs from the protected rollout"));
});

export const resumePairingRollback = Effect.fn(function* (
  input: PartialRollback & { port: FallbackRepairPort & RollbackPort }
) {
  const {
    port,
    receipt: { release, promoted },
  } = input;

  const { core, revision } = release.snapshot;
  yield* releaseController.requireTrunk(port, revision);
  yield* requireRestoredIngress(port, input);
  const before = yield* coreRollbackPosition(port, input.receipt);

  if (Option.isSome(before)) return before.value;

  if (!(yield* port.deployable(core.name, core.stableVersionId))) {
    return yield* Effect.fail(Error("Sealed Core version is no longer deployable"));
  }

  yield* releaseController.requireTrunk(port, revision);
  yield* requireRestoredIngress(port, input);
  const ready = yield* coreRollbackPosition(port, input.receipt);

  if (Option.isSome(ready)) return ready.value;

  const restored = yield* releaseRollback.routeStable(port, core.name, {
    stableId: core.stableVersionId,
    previous: { id: promoted.coreDeploymentId, version: release.coreVersionId },
  });

  yield* requireRestoredIngress(port, input);

  if (
    !Option.exists(
      yield* coreRollbackPosition(port, input.receipt),
      (current) => current.id === restored.id
    )
  ) {
    return yield* Effect.fail(Error("Rollback Core restoration could not be confirmed"));
  }

  return restored;
});

type ArchivedPair = typeof archivedPairing;

const matchesArchivedPair = (value: Release, archive: ArchivedPair): boolean =>
  value.snapshot.revision === archive.revision &&
  (["public", "core"] as const).every(
    (role) =>
      value[`${role}VersionId`] === archive[`${role}VersionId`] &&
      value[`${role}DeploymentId`] === archive[`${role}DeploymentId`]
  );

export const matchesArchivedStage = (value: Release): boolean =>
  matchesArchivedPair(value, archivedDormant);

type StageReader = Pick<FallbackRepairPort, "recentDeployments" | "trunk">;

const matchesOriginalStage = (
  observed: Deployment,
  role: Role,
  archive: ArchivedPair = archivedDormant
): boolean =>
  observed.id === archive[`${role}DeploymentId`] &&
  hasZeroCandidate(observed, archivedDormant.original[role], archive[`${role}VersionId`]);

const archivedSource = (source: Release["snapshot"]): Option.Option<ArchivedPair> =>
  EffectArray.findFirst([archivedDormant, archivedPairing], (archive) =>
    (["core", "public"] as const).every(
      (role) =>
        source[role].deploymentId === archive[`${role}DeploymentId`] &&
        source[role].stableVersionId === archivedDormant.original[role]
    )
  );

export const fromArchivedStage = (source: Release["snapshot"]): boolean =>
  Option.isSome(archivedSource(source));

export const matchesReplacementPredecessor = ({
  prior,
  snapshot,
}: {
  prior: Release;
  snapshot: Release["snapshot"];
}): boolean => {
  const archive = archivedSource(snapshot);

  return (
    Option.isSome(archive) &&
    matchesArchivedPair(prior, archive.value) &&
    isDeepStrictEqual(snapshot, {
      ...prior.snapshot,
      revision: snapshot.revision,
      core: { ...prior.snapshot.core, deploymentId: prior.coreDeploymentId },
      public: { ...prior.snapshot.public, deploymentId: prior.publicDeploymentId },
    })
  );
};

export const requireDormantReplacementSource = Effect.fn(function* (
  port: FallbackRepairPort,
  snapshot: Release["snapshot"]
) {
  yield* releaseController.requireTrunk(port, snapshot.revision);
  const archive = archivedSource(snapshot);

  if (Option.isNone(archive)) {
    return yield* Effect.fail(Error("Closed replacement source is not an archived pair"));
  }

  yield* Effect.forEach(
    ["core", "public"] as const,
    Effect.fnUntraced(function* (role) {
      const captured = snapshot[role];
      const [active] = yield* port.recentDeployments(captured.name);

      if (active === undefined || !matchesOriginalStage(active, role, archive.value)) {
        return yield* Effect.fail(
          Error("Closed replacement source differs from the archived deployment")
        );
      }
    }),
    { discard: true }
  );
});

const uploadedPosition = Effect.fn(function* (
  port: StageReader,
  snapshot: Release["snapshot"],
  role: Role
) {
  const captured = snapshot[role];
  const [active, previous] = yield* port.recentDeployments(captured.name);

  if (active !== undefined && matchesOriginalStage(active, role)) {
    return { id: active.id, staged: false };
  }

  if (
    active === undefined ||
    previous === undefined ||
    !matchesOriginalStage(previous, role) ||
    active.id === previous.id ||
    !hasZeroCandidate(active, captured.stableVersionId, uploadedPair[`${role}VersionId`])
  ) {
    return yield* Effect.fail(Error("Interrupted pairing upload has unrelated deployment history"));
  }

  return { id: active.id, staged: true };
});

const uploadedAssignments = Effect.fn(function* (
  port: FallbackRepairPort,
  snapshot: Release["snapshot"]
) {
  yield* releaseController.requireTrunk(port, snapshot.revision);
  const core = yield* uploadedPosition(port, snapshot, "core");
  const ingress = yield* uploadedPosition(port, snapshot, "public");

  if (core.staged && !ingress.staged) {
    return yield* Effect.fail(Error("Unexpected interrupted stage order"));
  }

  return { core, public: ingress };
});

const confirmUploadedAssignment = (
  role: Role,
  observed: Effect.Success<ReturnType<typeof uploadedAssignments>>,
  expected: { deployment: string; other: string }
): boolean =>
  observed[role].staged &&
  observed[role].id === expected.deployment &&
  observed[role === "core" ? "public" : "core"].id === expected.other;

export const stageUploadedPair = Effect.fn(function* <E, R>(
  port: FallbackRepairPort,
  snapshot: Release["snapshot"],
  verify: Effect.Effect<void, E, R>
) {
  if (
    snapshot.revision !== uploadedPair.revision ||
    !Option.contains(archivedSource(snapshot), archivedDormant)
  ) {
    return yield* Effect.fail(Error("Unexpected interrupted pairing upload snapshot"));
  }

  let positions = yield* uploadedAssignments(port, snapshot);
  yield* verify;

  if (!isDeepStrictEqual(positions, yield* uploadedAssignments(port, snapshot))) {
    return yield* Effect.fail(Error("Pair changed during pre-stage qualification"));
  }

  yield* Effect.forEach(
    ["public", "core"] as const,
    Effect.fnUntraced(function* (role) {
      if (positions[role].staged) return;
      const other = role === "public" ? "core" : "public";

      const staged = yield* releaseController.deployExact(port, snapshot[role].name, [
        { id: snapshot[role].stableVersionId, percentage: 100 },
        { id: uploadedPair[`${role}VersionId`], percentage: 0 },
      ]);

      const observed = yield* uploadedAssignments(port, snapshot);

      if (
        !confirmUploadedAssignment(role, observed, {
          deployment: staged.id,
          other: positions[other].id,
        })
      ) {
        return yield* Effect.fail(Error("Unexpected traffic after staging uploaded Worker"));
      }

      positions = observed;
    }),
    { discard: true }
  );

  return {
    snapshot,
    publicVersionId: uploadedPair.publicVersionId,
    coreVersionId: uploadedPair.coreVersionId,
    publicDeploymentId: positions.public.id,
    coreDeploymentId: positions.core.id,
  };
});

export const requirePromotedDormantSource = Effect.fn(function* (
  port: StageReader,
  snapshot: Release["snapshot"],
  sealed?: Release
) {
  yield* Effect.forEach(
    ["core", "public"] as const,
    Effect.fnUntraced(function* (role) {
      const [active, staged] = yield* port.recentDeployments(snapshot[role].name);
      const version = (sealed ?? archivedDormant)[`${role}VersionId`];

      const expected = {
        id: snapshot[role].deploymentId,
        versions: [{ id: version, percentage: 100 }],
      };

      const ownsStage =
        staged !== undefined &&
        (sealed !== undefined
          ? matchesStage(staged, sealed, role)
          : matchesOriginalStage(staged, role));

      if (
        !isDeepStrictEqual(active, expected) ||
        snapshot[role].stableVersionId !== version ||
        !ownsStage
      ) {
        return yield* Effect.fail(
          Error("Active source differs from the sealed dormant deployment history")
        );
      }
    }),
    { discard: true }
  );
});

const requireUnpromotedHistory = Effect.fn(function* (port: StageReader, release: Release) {
  if ((yield* port.trunk()) !== release.snapshot.revision) {
    return yield* Effect.fail(Error("Staged release verifier is no longer protected trunk"));
  }

  const archive = archivedSource(release.snapshot);

  yield* Effect.forEach(
    ["core", "public"] as const,
    Effect.fnUntraced(function* (role) {
      const snapshot = release.snapshot[role];
      const [active, original] = yield* port.recentDeployments(snapshot.name);

      if (
        active === undefined ||
        !matchesStage(active, release, role) ||
        (Option.isSome(archive)
          ? original === undefined || !matchesOriginalStage(original, role, archive.value)
          : !isDeepStrictEqual(original, {
              id: snapshot.deploymentId,
              versions: [{ id: snapshot.stableVersionId, percentage: 100 }],
            }))
      ) {
        return yield* Effect.fail(Error("Staged pair or original deployment history differs"));
      }
    }),
    { discard: true }
  );
});

export const verifyUnpromotedFallback = Effect.fn(function* <A, E, R>(input: {
  port: StageReader;
  release: Release;
  verify: Effect.Effect<A, E, R>;
}) {
  yield* requireUnpromotedHistory(input.port, input.release).pipe(
    Effect.tapCause(() =>
      Effect.logError("Staged deployment history differs from the archived 100/0 pair.")
    )
  );
  const result = yield* input.verify;
  yield* requireUnpromotedHistory(input.port, input.release).pipe(
    Effect.tapCause(() =>
      Effect.logError("Staged deployment history differs from the archived 100/0 pair.")
    )
  );

  return result;
});

const workerPosition = Effect.fn(function* (
  port: FallbackRepairPort,
  release: Release,
  role: Role
) {
  const [active, previous] = yield* port.recentDeployments(release.snapshot[role].name);

  if (active === undefined) return yield* Effect.fail(Error("Missing fallback deployment history"));

  if (matchesStage(active, release, role)) return { id: active.id, serving: false };

  const onlyDormant =
    active.versions.length === 1 &&
    active.versions.some(
      (version) => version.id === release[`${role}VersionId`] && version.percentage === 100
    );

  if (
    onlyDormant &&
    previous !== undefined &&
    active.id !== previous.id &&
    matchesStage(previous, release, role)
  ) {
    return { id: active.id, serving: true };
  }

  return yield* Effect.fail(Error("Traffic no longer follows the archived dormant stage"));
});

const positions = Effect.fn(function* (port: FallbackRepairPort, release: Release) {
  yield* releaseController.requireTrunk(port, release.snapshot.revision);
  const core = yield* workerPosition(port, release, "core");
  const ingress = yield* workerPosition(port, release, "public");

  if (ingress.serving && !core.serving) {
    return yield* Effect.fail(Error("Dormant Ingress advanced before its Core"));
  }

  return { core, public: ingress };
});

const requireUnchanged = (before: Pair, after: Pair): Effect.Effect<void, Error> =>
  before.core.id === after.core.id && before.public.id === after.public.id
    ? Effect.void
    : Effect.fail(Error("Dormant deployment changed during verification"));

const advance = Effect.fn(function* (
  port: FallbackRepairPort,
  release: Release,
  input: { role: Role; pair: Pair }
) {
  const { role, pair } = input;

  if (pair[role].serving) return pair;
  const other = role === "core" ? "public" : "core";

  const promoted = yield* releaseController.deployExact(port, release.snapshot[role].name, [
    { id: release[`${role}VersionId`], percentage: 100 },
  ]);

  const observed = yield* positions(port, release);

  if (
    !observed[role].serving ||
    observed[role].id !== promoted.id ||
    observed[other].id !== pair[other].id
  ) {
    return yield* Effect.fail(Error("Unexpected traffic after dormant promotion"));
  }

  return observed;
});

export const recoverFixtureFallback = Effect.fn(function* (
  port: FallbackRepairPort,
  stage: FallbackStage,
  verifyDormant: (archive: FallbackStage, phase: "before" | "after") => Effect.Effect<void, Error>
) {
  if (!fixedCoordinates(stage)) {
    return yield* Effect.fail(Error("Inconsistent dormant fallback stage"));
  }

  const { release } = stage;
  const before = yield* positions(port, release);
  yield* verifyDormant(stage, "before");
  const checked = yield* positions(port, release);
  yield* requireUnchanged(before, checked);
  const core = yield* advance(port, release, { role: "core", pair: checked });
  const both = yield* advance(port, release, { role: "public", pair: core });
  yield* verifyDormant(stage, "after");
  yield* requireUnchanged(both, yield* positions(port, release));

  return { publicDeploymentId: both.public.id, coreDeploymentId: both.core.id };
});
