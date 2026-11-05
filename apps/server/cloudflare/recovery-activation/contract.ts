import { type Effect, Schema } from "effect";
import { ErasureGeneration, ErasureSourceFreezeDescriptor } from "../erasure-store/contract";
import type { ErasureUnavailable } from "../erasure-store/contract";

const maximumIdentityLength = 128;
const activationName = Schema.String.check(Schema.isBetweenLength(1, maximumIdentityLength));
export const RecoveryTarget = Schema.Struct({
  namespaceId: activationName,
  objectId: activationName,
  manifest: activationName,
  epoch: activationName,
});
export type RecoveryTarget = typeof RecoveryTarget.Type;
export const RecoverySourceTarget = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("D1"),
    databaseId: Schema.String.check(Schema.isUUID()),
    epoch: activationName,
  }),
  Schema.Struct({ kind: Schema.Literal("SQLite"), ...RecoveryTarget.fields }),
]);
export type RecoverySourceTarget = typeof RecoverySourceTarget.Type;
/** Issued from the independently persisted final barrier, never from a restored SQL row or a caller assertion. */
export const RecoveryClosedSourceEvidence = Schema.Struct({
  activationId: Schema.String.check(Schema.isUUID()),
  admissionObjectId: Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/u)),
  source: RecoverySourceTarget,
  sourceGeneration: ErasureGeneration,
  sourceFreeze: ErasureSourceFreezeDescriptor,
  finalGeneration: Schema.String.check(Schema.isUUID()),
  finalCheckpointEtag: activationName,
  providerEvidenceDigest: Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/u)),
  ledgerDigest: Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/u)),
});
export type RecoveryClosedSourceEvidence = typeof RecoveryClosedSourceEvidence.Type;
/** The implementation owns fixed bindings and validates the external phase plus the actual closed, drained gate on every read. */
export type RecoveryClosedSourceAccess = (
  expected: Readonly<{ activationId: string; source: RecoverySourceTarget }>
) => Effect.Effect<RecoveryClosedSourceEvidence, ErasureUnavailable>;

/** Only an independent external phase may authorize a previously unopened exact target's fixed artifact. */
export const RecoveryBootstrapAuthorization = Schema.Struct({
  phase: Schema.Literal("BootstrapAuthorized"),
  evidence: RecoveryClosedSourceEvidence,
  target: RecoveryTarget,
  artifactDigest: Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/u)),
});
export type RecoveryBootstrapAuthorization = typeof RecoveryBootstrapAuthorization.Type;
export type RecoveryBootstrapAccess = (
  expected: Readonly<{ activationId: string; target: RecoveryTarget; artifactDigest: string }>
) => Effect.Effect<RecoveryBootstrapAuthorization, ErasureUnavailable>;

/** Data verification is insufficient: serving needs independent exact owner-version and final external evidence. */
export const RecoveryServingAuthorization = Schema.Struct({
  phase: Schema.Literal("ServingAuthorized"),
  evidence: RecoveryClosedSourceEvidence,
  target: RecoveryTarget,
  artifactDigest: Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/u)),
  ownerVersion: Schema.String.check(Schema.isUUID()),
});
export type RecoveryServingAuthorization = typeof RecoveryServingAuthorization.Type;
export type RecoveryServingAccess = (
  expected: Readonly<{
    activationId: string;
    target: RecoveryTarget;
    artifactDigest: string;
    ownerVersion: string;
  }>
) => Effect.Effect<RecoveryServingAuthorization, ErasureUnavailable>;

/** Cleanup only follows an independently earned disposition of the exact fixed artifact. */
export const RecoveryArtifactRetirement = Schema.Struct({
  phase: Schema.Literal("ArtifactRetirementAuthorized"),
  reason: Schema.Literals(["Abandoned", "OpenedQualified"]),
  activationId: Schema.String.check(Schema.isUUID()),
  target: RecoveryTarget,
  artifactDigest: Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/u)),
});
export type RecoveryArtifactRetirement = typeof RecoveryArtifactRetirement.Type;
export type RecoveryArtifactRetirementAccess = (
  expected: Readonly<{
    activationId: string;
    target: RecoveryTarget;
    artifactDigest: string;
  }>
) => Effect.Effect<RecoveryArtifactRetirement, ErasureUnavailable>;

export const RecoveryStoreObservation = Schema.Struct({
  target: RecoveryTarget,
  admission: Schema.Literals(["Open", "Closed"]),
  activationId: Schema.String,
  queryLeases: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  releaseBarrier: Schema.Literals(["Unqualified", "Drained"]),
});
export type RecoveryStoreObservation = typeof RecoveryStoreObservation.Type;
export type RecoveryStoreControl = Readonly<{
  inspect: () => Promise<unknown>;
  close: (input: Readonly<{ activationId: string; epoch: string }>) => Promise<unknown>;
}>;
export type RecoveryActivationEnvironment = Readonly<{
  admission: RecoveryAdmissionBinding;
  serving: RecoveryStoreControl;
  sourceDb: D1Database;
  sourceTarget: RecoverySourceTarget;
  servingTarget: RecoveryTarget;
}>;

export const RecoveryLease = Schema.Struct({
  epoch: Schema.String,
  leaseId: Schema.String.check(Schema.isBetweenLength(1, maximumIdentityLength)),
});
export const RecoveryClose = Schema.Struct({
  epoch: Schema.String,
  activationId: Schema.String.check(Schema.isBetweenLength(1, maximumIdentityLength)),
});
export const RecoveryControllerClaim = Schema.Struct({
  ...RecoveryClose.fields,
  claimId: Schema.String.check(Schema.isUUID()).pipe(Schema.brand("RecoveryControllerClaimId")),
});
export type RecoveryControllerClaim = typeof RecoveryControllerClaim.Type;
export const RecoveryAdmissionState = Schema.Struct({
  objectId: Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/u)),
  epoch: Schema.String,
  activationId: Schema.String,
  closed: Schema.Boolean,
  paused: Schema.Boolean,
  leases: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  controllerBusy: Schema.Boolean,
});
export type RecoveryAdmissionState = typeof RecoveryAdmissionState.Type;
export type RecoveryAdmissionBinding = Readonly<{
  inspect: () => Promise<unknown>;
  acquireController: (input: RecoveryControllerClaim) => Promise<boolean>;
  releaseController: (input: RecoveryControllerClaim) => Promise<boolean>;
  retainController: (input: RecoveryControllerClaim) => Promise<boolean>;
  pause: (input: typeof RecoveryClose.Type) => Promise<unknown>;
  enterContinuation: (input: typeof RecoveryLease.Type) => Promise<boolean>;
  enter: (input: typeof RecoveryLease.Type) => Promise<boolean>;
  complete: (input: typeof RecoveryLease.Type) => Promise<boolean>;
  close: (input: typeof RecoveryClose.Type) => Promise<unknown>;
}>;
export type RecoveryAdmissionEnvironment = Partial<
  Readonly<{
    RECOVERY_ADMISSION: Readonly<{ getByName: (name: string) => RecoveryAdmissionBinding }>;
    RECOVERY_SOURCE_EPOCH: string;
  }>
>;
