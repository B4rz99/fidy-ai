import { Effect, Option, Schema } from "effect";
import { readRecoveryServingAuthorization } from "../../recovery-activation/operations";
import {
  RecoveryClosedSourceEvidence,
  RecoveryServingAuthorization,
} from "../../recovery-activation/contract";
import { prepareClosedSourceGenerationFence } from "../../erasure/operations";
import { SnapshotDigest, SnapshotUnavailable } from "../../sqlite-snapshot/contract";
import {
  type SqliteStoreControlReply,
  type SqliteStoreControlRequest,
  SqliteStoreObservation,
} from "../contract";
import { type NativeStore, storeObservation } from "./gate";
import { ImportCheckpoint } from "./import-checkpoint";
import { sqliteDatabaseUnit } from "./database";

const DataSeal = Schema.Struct({
  manifest: Schema.String,
  epoch: Schema.String,
  status: Schema.Literal("verified"),
  activationId: Schema.String.check(Schema.isUUID()),
  artifactDigest: SnapshotDigest,
  finalGeneration: RecoveryClosedSourceEvidence.fields.finalGeneration,
  finalCheckpointEtag: RecoveryClosedSourceEvidence.fields.finalCheckpointEtag,
});
const Readiness = Schema.Struct({
  seal: DataSeal,
  checkpoint: ImportCheckpoint,
  observation: SqliteStoreObservation,
  ownerVersion: RecoveryServingAuthorization.fields.ownerVersion,
});
const encodeReadiness = Schema.encodeSync(Schema.fromJsonString(Readiness));
const encodeAuthorization = Schema.encodeSync(Schema.fromJsonString(RecoveryServingAuthorization));
type OpenInput = Readonly<{ store: NativeStore; request: typeof SqliteStoreControlRequest.Type }>;
const assertAdmission = ({
  input,
  retained,
}: Readonly<{ input: OpenInput; retained: typeof Readiness.Type }>): void => {
  const { observation, seal } = retained;
  if (
    observation.admission !== "Closed" ||
    observation.activationId !== input.request.activationId ||
    observation.target.epoch !== input.request.epoch ||
    seal.activationId !== input.request.activationId ||
    seal.activationId !== input.store.environment.SQLITE_STORE_ACTIVATION_ID ||
    seal.artifactDigest !== input.store.environment.SQLITE_STORE_ARTIFACT_DIGEST
  ) {
    throw Error("Serving readiness unavailable");
  }
};
const assertArtifact = (retained: typeof Readiness.Type): void => {
  const { seal, checkpoint } = retained;
  const bound = checkpoint.authorization;
  if (
    checkpoint.phase !== "ErasureVerification" ||
    checkpoint.stage !== "Complete" ||
    checkpoint.activationId !== bound.evidence.activationId ||
    seal.activationId !== bound.evidence.activationId ||
    seal.artifactDigest !== bound.artifactDigest ||
    seal.finalGeneration !== bound.evidence.finalGeneration ||
    seal.finalCheckpointEtag !== bound.evidence.finalCheckpointEtag
  ) {
    throw Error("Serving readiness unavailable");
  }
};
const readiness = (input: OpenInput): typeof Readiness.Type => {
  const observation = Option.getOrThrow(storeObservation(input.store));
  const retained = Schema.decodeUnknownSync(Readiness)({
    seal: input.store.storage.kv.get("store-seal"),
    checkpoint: input.store.storage.kv.get("store-bootstrap"),
    observation,
    ownerVersion: input.store.environment.CF_VERSION_METADATA?.id,
  });
  const { seal, checkpoint } = retained;
  const bound = checkpoint.authorization;
  assertAdmission({ input, retained });
  assertArtifact(retained);
  const expected: RecoveryServingAuthorization = {
    phase: "ServingAuthorized",
    evidence: bound.evidence,
    target: observation.target,
    artifactDigest: seal.artifactDigest,
    ownerVersion: retained.ownerVersion,
  };
  const pinned: RecoveryServingAuthorization = { ...expected, target: bound.target };
  const copied: RecoveryServingAuthorization = {
    ...expected,
    evidence: checkpoint.manifest.evidence,
    target: checkpoint.manifest.target,
    artifactDigest: checkpoint.artifactDigest,
  };
  if (
    encodeAuthorization(expected) !== encodeAuthorization(pinned) ||
    encodeAuthorization(expected) !== encodeAuthorization(copied)
  ) {
    throw Error("Serving target mismatch");
  }
  return retained;
};
const authorizationFor = (retained: typeof Readiness.Type): RecoveryServingAuthorization => ({
  phase: "ServingAuthorized",
  evidence: retained.checkpoint.authorization.evidence,
  target: retained.observation.target,
  artifactDigest: retained.seal.artifactDigest,
  ownerVersion: retained.ownerVersion,
});
/** Caller metadata never supplies authority: the independent exact final record must authorize this actual owner and artifact. */
export const openStore = (input: OpenInput): Effect.Effect<SqliteStoreControlReply> =>
  Effect.gen(function* () {
    const retained = readiness(input);
    const expected = authorizationFor(retained);
    const authorization = yield* readRecoveryServingAuthorization({
      activationId: input.request.activationId,
      target: expected.target,
      artifactDigest: expected.artifactDigest,
      ownerVersion: expected.ownerVersion,
    }).pipe(Effect.flatMap(Schema.decodeEffect(RecoveryServingAuthorization)));
    if (encodeAuthorization(authorization) !== encodeAuthorization(expected)) {
      return yield* new SnapshotUnavailable();
    }
    return input.store.storage.transactionSync(() => {
      if (encodeReadiness(readiness(input)) !== encodeReadiness(retained)) {
        throw Error("Serving readiness changed");
      }
      const { database, run } = sqliteDatabaseUnit(input.store.storage);
      run([
        prepareClosedSourceGenerationFence({
          db: database,
          generation: authorization.evidence.finalGeneration,
        }),
      ]);
      input.store.storage.kv.put("store-admission", { phase: "Open", epoch: input.request.epoch });
      return Option.getOrThrow(storeObservation(input.store));
    });
  }).pipe(
    Effect.catchCause(() => Effect.succeed({ kind: "refused", reason: "inactive" } as const))
  );
