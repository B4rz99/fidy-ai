import { Effect, Option, Schema } from "effect";
import { readRecoveryBootstrapAuthorization } from "../../recovery-activation/operations";
import {
  RecoveryBootstrapAuthorization,
  type RecoveryClosedSourceEvidence,
  RecoveryTarget,
} from "../../recovery-activation/contract";
import { readSnapshotArtifact } from "../../sqlite-snapshot/operations";
import { SnapshotDigest, SnapshotUnavailable } from "../../sqlite-snapshot/contract";
import {
  prepareClosedSourceGenerationFence,
  verifyImportedErasureCheckpoint,
} from "../../erasure/operations";
import { sqliteDatabaseUnit } from "./database";
import type { SqliteBootstrapTarget, SqliteStoreEnvironment } from "../contract";
import { bootstrapTarget } from "./bootstrap-target";
import { advanceImport } from "./import";

const Configuration = Schema.Struct({
  activationId: Schema.String.check(Schema.isUUID()),
  artifactDigest: SnapshotDigest,
});
const configured = (
  environment: SqliteStoreEnvironment
): Option.Option<typeof Configuration.Type> =>
  Schema.decodeUnknownOption(Configuration)({
    activationId: environment.SQLITE_STORE_ACTIVATION_ID,
    artifactDigest: environment.SQLITE_STORE_ARTIFACT_DIGEST,
  });
/** Only a never-initialized explicit candidate schedules work; existing or malformed seals are never repaired by bootstrap. */
export const bootstrapPending = (
  input: Readonly<{ state: DurableObjectState; environment: SqliteStoreEnvironment }>
): boolean =>
  input.state.storage.kv.get("store-seal") === undefined &&
  input.state.storage.kv.get("store-bootstrap") === undefined &&
  Option.isSome(configured(input.environment)) &&
  input.environment.SQLITE_STORE_ARTIFACTS !== undefined &&
  input.environment.ERASURE_BUCKET !== undefined;
/** Alarm-only local consumption. Independent authorization is re-read before every bounded native unit; its local data seal grants neither Open admission nor provider qualification. */
export const bootstrapStep = (
  input: Readonly<{ state: DurableObjectState; environment: SqliteStoreEnvironment }>
): Effect.Effect<boolean, SnapshotUnavailable> =>
  Effect.gen(function* () {
    const configuration = yield* Effect.fromOption(configured(input.environment)).pipe(
      Effect.mapError(() => new SnapshotUnavailable())
    );
    const candidate: unknown = {
      namespaceId: input.environment.SQLITE_STORE_NAMESPACE_ID,
      objectId: input.state.id.toString(),
      manifest: input.environment.SQLITE_STORE_MANIFEST,
      epoch: input.environment.SQLITE_STORE_EPOCH,
    };
    const target = yield* Schema.decodeUnknownEffect(RecoveryTarget)(candidate);
    const artifacts = input.environment.SQLITE_STORE_ARTIFACTS;
    const bucket = input.environment.ERASURE_BUCKET;
    if (
      artifacts === undefined ||
      bucket === undefined ||
      input.state.storage.kv.get("store-seal") !== undefined
    ) {
      return yield* new SnapshotUnavailable();
    }
    const authorization = yield* readRecoveryBootstrapAuthorization({
      ...configuration,
      target,
    }).pipe(Effect.flatMap(Schema.decodeEffect(RecoveryBootstrapAuthorization)));
    if (authorization.evidence.activationId !== configuration.activationId) {
      return yield* new SnapshotUnavailable();
    }
    const result = yield* advanceImport({
      ...input,
      authorization,
      readArtifact: (digest) =>
        readSnapshotArtifact({
          artifacts,
          target,
          activationId: configuration.activationId,
          digest,
        }),
    });
    if (result.phase === "Importing") return true;
    const local = bootstrapTarget({ ...input, activationId: configuration.activationId });
    const imported = yield* verifyImportedErasureCheckpoint({
      target: local,
      evidence: authorization.evidence,
      bucket,
    });
    if (imported.state !== "Verified") return true;
    sealData({ local, evidence: authorization.evidence });
    // This local data seal leaves admission Closed and the external release barrier Unqualified.
    return false;
  }).pipe(Effect.catchCause(() => Effect.fail(new SnapshotUnavailable())));

const sealData = ({
  local,
  evidence,
}: Readonly<{ local: SqliteBootstrapTarget; evidence: RecoveryClosedSourceEvidence }>): void =>
  local.storage.transactionSync(() => {
    local.assertInactive();
    const { database, run } = sqliteDatabaseUnit(local.storage);
    run([
      prepareClosedSourceGenerationFence({ db: database, generation: evidence.finalGeneration }),
    ]);
    local.storage.kv.put("store-seal", {
      manifest: local.target.manifest,
      epoch: local.target.epoch,
      status: "verified",
      activationId: local.activationId,
      artifactDigest: local.artifactDigest,
      finalGeneration: evidence.finalGeneration,
      finalCheckpointEtag: evidence.finalCheckpointEtag,
    });
  });
