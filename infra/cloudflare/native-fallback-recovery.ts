import { Effect, Schema } from "effect";
import { gitRevisionPattern } from "../../apps/server/cloudflare/runtime/contract";
import { SmokeIdentity } from "../../apps/server/cloudflare/runtime/release-smoke/contract";
import {
  type Deployment,
  type ReleasePort,
  releaseController,
  releaseSchemas,
} from "./release-controller";

const Revision = Schema.String.check(Schema.isPattern(gitRevisionPattern));
const Namespace = Schema.String.check(Schema.isPattern(/^[a-f0-9]{32}$/u));
const Version = SmokeIdentity.fields.workerVersionId;
export const FallbackStage = Schema.Struct({
  revision: Revision,
  stableRevision: Revision,
  release: releaseSchemas.staged,
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
    /** Ordered from the newest deployment, including its immediate predecessor when available. */
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
const matchesStage = (deployment: Deployment, release: Release, role: Role): boolean =>
  deployment.id === release[`${role}DeploymentId`] &&
  deployment.versions.length === 2 &&
  deployment.versions.some(
    (version) => version.id === release[`${role}VersionId`] && version.percentage === 0
  ) &&
  deployment.versions.some(
    (version) => version.id === release.snapshot[role].stableVersionId && version.percentage === 100
  );

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

/** Finish only the captured Core-first transition. A lost write reply resumes from provider history. */
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
