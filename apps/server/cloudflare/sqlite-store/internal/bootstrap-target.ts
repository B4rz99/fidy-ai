import { Option, Schema } from "effect";
import { RecoveryTarget } from "../../recovery-activation/contract";
import type { SqliteBootstrapTarget, SqliteBootstrapTargetInput } from "../contract";
import { StoreAdmission } from "./gate";

const Checkpoint = Schema.Struct({
  activationId: Schema.String.check(Schema.isUUID()),
  artifactDigest: Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/u)),
  phase: Schema.Literal("ErasureVerification"),
});
const inactive = (input: SqliteBootstrapTargetInput, artifactDigest: string): void => {
  const storage = input.state.storage;
  const admission = Schema.decodeUnknownOption(StoreAdmission)(storage.kv.get("store-admission"));
  const checkpoint = Schema.decodeUnknownSync(Checkpoint)(storage.kv.get("store-bootstrap"));
  if (storage.kv.get("store-seal") !== undefined || Option.isNone(admission)) {
    throw new Error("Bootstrap target unavailable");
  }
  if (
    admission.value.phase !== "Closed" ||
    admission.value.activationId !== input.activationId ||
    admission.value.epoch !== input.environment.SQLITE_STORE_EPOCH ||
    checkpoint.activationId !== input.activationId ||
    checkpoint.artifactDigest !== artifactDigest
  ) {
    throw new Error("Bootstrap target unavailable");
  }
};
export const bootstrapTarget = (input: SqliteBootstrapTargetInput): SqliteBootstrapTarget => {
  const target = Schema.decodeUnknownSync(RecoveryTarget)({
    namespaceId: input.environment.SQLITE_STORE_NAMESPACE_ID,
    objectId: input.state.id.toString(),
    manifest: input.environment.SQLITE_STORE_MANIFEST,
    epoch: input.environment.SQLITE_STORE_EPOCH,
  });
  const artifactDigest = Schema.decodeUnknownSync(Checkpoint.fields.artifactDigest)(
    input.environment.SQLITE_STORE_ARTIFACT_DIGEST
  );
  const assertInactive = (): void => inactive(input, artifactDigest);
  assertInactive();
  return {
    storage: input.state.storage,
    objectId: input.state.id.toString(),
    target,
    activationId: input.activationId,
    artifactDigest,
    assertInactive,
  };
};
