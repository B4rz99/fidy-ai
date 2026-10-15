import { Effect, Schema } from "effect";
import { SmokeIdentity } from "../../apps/server/cloudflare/runtime/release-smoke/contract";
import { type Deployment, type ReleasePort, releaseController } from "./release-controller";

const RecoveryWorker = Schema.Struct({
  name: Schema.String.check(Schema.isPattern(/^[a-zA-Z0-9_-]{1,80}$/u)),
  deploymentId: SmokeIdentity.fields.workerVersionId,
  candidateVersionId: SmokeIdentity.fields.workerVersionId,
});
export const RecoveryRequest = Schema.Struct({
  revision: SmokeIdentity.fields.gitRevision,
  public: RecoveryWorker,
  core: RecoveryWorker,
});
export type RecoveryPort = ReleasePort &
  Readonly<{
    verifyPair(pair: {
      publicVersionId: string;
      coreVersionId: string;
    }): Effect.Effect<void, Error>;
  }>;
const servingVersion = Effect.fn(function* (port: ReleasePort, worker: typeof RecoveryWorker.Type) {
  const current = yield* port.current(worker.name);
  const stable = current.versions.find((version) => version.percentage === 100);
  const candidate = current.versions.find((version) => version.id === worker.candidateVersionId);
  if (
    current.id !== worker.deploymentId ||
    current.versions.length !== 2 ||
    stable === undefined ||
    candidate?.percentage !== 0 ||
    stable.id === candidate.id
  ) {
    return yield* Effect.fail(Error("Recovery refused: inspected zero-traffic deployment changed"));
  }
  return { current, stableVersionId: stable.id };
});
const requireUnchanged = Effect.fn(function* (
  port: ReleasePort,
  revision: string,
  deployments: ReadonlyMap<string, Deployment>
) {
  if ((yield* port.trunk()) !== revision) {
    return yield* Effect.fail(Error("Recovery superseded by trunk; inspect traffic"));
  }
  for (const [name, expected] of deployments) {
    const observed = yield* port.current(name);
    if (
      observed.id !== expected.id ||
      observed.versions.length !== expected.versions.length ||
      !expected.versions.every((version) =>
        observed.versions.some(
          (actual) => actual.id === version.id && actual.percentage === version.percentage
        )
      )
    ) {
      return yield* Effect.fail(Error("Recovery refused: Worker routing changed"));
    }
  }
});
/** Removes only inspected 0% candidates, preserving and verifying the current 100% pair. */
export const recoverStaged = Effect.fn(function* (
  port: RecoveryPort,
  request: typeof RecoveryRequest.Type
) {
  if (request.public.name === request.core.name) {
    return yield* Effect.fail(Error("Recovery requires distinct public and Core Workers"));
  }
  const ingress = yield* servingVersion(port, request.public);
  const core = yield* servingVersion(port, request.core);
  const pair = { publicVersionId: ingress.stableVersionId, coreVersionId: core.stableVersionId };
  const deployments = new Map([
    [request.public.name, ingress.current],
    [request.core.name, core.current],
  ]);
  yield* requireUnchanged(port, request.revision, deployments);
  yield* port.verifyPair(pair);
  for (const worker of [request.public, request.core]) {
    yield* requireUnchanged(port, request.revision, deployments);
    const stableVersionId =
      worker.name === request.public.name ? pair.publicVersionId : pair.coreVersionId;
    const observed = yield* releaseController.deployExact(port, worker.name, [
      { id: stableVersionId, percentage: 100 },
    ]);
    deployments.set(worker.name, observed);
  }
  yield* requireUnchanged(port, request.revision, deployments);
  yield* port.verifyPair(pair);
});
