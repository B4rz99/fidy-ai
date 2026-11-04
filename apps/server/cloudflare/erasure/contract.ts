import type { SqliteBootstrapTarget } from "../sqlite-store/contract";
import { ErasureGeneration } from "../erasure-store/contract";
import {
  type RecoveryActivationEnvironment,
  type RecoveryAdmissionEnvironment,
  type RecoveryClosedSourceEvidence,
  RecoveryTarget,
} from "../recovery-activation/contract";
import type { ErasureOriginals, ErasureStore, ErasureUnavailable } from "../erasure-store/contract";
import type { Effect } from "effect";
import { type Option, Schema } from "effect";
import { WebSessionId } from "../../src/core/web-session/contract";
import { UserId } from "../../src/core/identity/contract";
import { ErasureCustodyEvidence, ErasureReference } from "../../src/core/erasure/contract";

const maximumOperatorLength = 256;

const digestLength = 32;
export const ErasureBrowserAdmission = Schema.Struct({
  userId: UserId,
  sessionId: WebSessionId,
  digest: Schema.Array(Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 255 }))).check(
    Schema.isBetweenLength(digestLength, digestLength)
  ),
  deadlineMs: Schema.Int,
});
export type ErasureBrowserAdmission = typeof ErasureBrowserAdmission.Type;
const ErasureAuthority = Schema.Struct({
  permission: Schema.Literal("titular.erase"),
  operatorRef: Schema.String.check(Schema.isBetweenLength(1, maximumOperatorLength)),
  expiresAtMs: Schema.Int,
});
export const ErasureContinuation = Schema.Struct({
  userId: UserId,
  reference: ErasureReference,
  deadlineMs: Schema.Int,
  authority: ErasureAuthority,
});
export type ErasureContinuation = typeof ErasureContinuation.Type;

export type ErasureOperatorConfiguration = Readonly<{
  issuer: string;
  audience: string;
  recoveryAudience: string;
  billingAudience: string;
}>;

export type ErasureRecoveryConfiguration = Readonly<{
  db: D1Database;
  bucket: Option.Option<R2Bucket>;
}>;

export const ErasureCustodyAdmission = Schema.Struct({
  ...ErasureContinuation.fields,
  evidence: ErasureCustodyEvidence,
});
export const ErasureRestoreAdmission = Schema.Struct({
  ...ErasureContinuation.fields,
  generation: ErasureGeneration,
});
export const ErasureOperatorAction = Schema.Union([
  Schema.Struct({ action: Schema.Literal("Initialize") }),
  Schema.Struct({ action: Schema.Literal("Restore") }),
  Schema.Struct({ action: Schema.Literal("VerifyCandidate") }),
  Schema.Struct({ action: Schema.Literal("Activation"), activationId: ErasureReference }),
  Schema.Struct({ action: Schema.Literal("ReleaseRestore") }),
  Schema.Struct({
    action: Schema.Literal("CustodyEvidence"),
    userId: UserId,
    evidence: ErasureCustodyEvidence,
  }),
  Schema.Struct({
    action: Schema.Literal("Continue"),
    userId: UserId,
    reference: ErasureReference,
  }),
  Schema.Struct({ action: Schema.Literal("Receipt"), userId: UserId, reference: ErasureReference }),
]);
export type ErasureOperatorEnvironment = RecoveryAdmissionEnvironment &
  Readonly<{
    DB: D1Database;
    CLOUDFLARE_ACCESS_ISSUER: string;
    CLOUDFLARE_ACCESS_AUDIENCE: string;
    USER_TRANSACTION_COORDINATOR: Readonly<{ getByName: (name: string) => Pick<Fetcher, "fetch"> }>;
  }> &
  Partial<
    Readonly<{
      ERASURE_SUPPORT_AUDIENCE: string;
      BILLING_SUPPORT_AUDIENCE: string;
      ERASURE_REQUIRED: string;
      ERASURE_BUCKET: R2Bucket;
      ERASURE_ACTIVATION: RecoveryActivationEnvironment;
    }>
  >;

export type ErasureExecution = Readonly<{
  db: D1Database;
  stores: ReadonlyArray<ErasureStore>;
  originals: ErasureOriginals;
  recovery: ErasureRecoveryConfiguration;
  clearCoordinator: () => Effect.Effect<boolean, ErasureUnavailable>;
}>;

export type ErasureRegistryInitialization<Requirements = never> = Readonly<{
  query: (statement: string) => Effect.Effect<unknown, ErasureUnavailable, Requirements>;
  exists: (key: string) => Effect.Effect<boolean, ErasureUnavailable, Requirements>;
  empty: Effect.Effect<boolean, ErasureUnavailable, Requirements>;
  install: (key: string, value: string) => Effect.Effect<boolean, ErasureUnavailable, Requirements>;
}>;

const databaseTargetId = Schema.String.check(Schema.isPattern(/^[a-zA-Z0-9-]{1,80}$/u));
export const ErasureCandidateConfiguration = Schema.Struct({
  ERASURE_CANDIDATE_DATABASE_ID: databaseTargetId,
  ERASURE_SERVING_DATABASE_ID: databaseTargetId,
});
export type ErasureCandidateEnvironment = ErasureOperatorEnvironment &
  typeof ErasureCandidateConfiguration.Type;

const importDigest = Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/u));
const maximumImportCursorLength = 2048;
const maximumLedgerKeyLength = 256;
export const ErasureImportedCheckpoint = Schema.Struct({
  artifactDigest: importDigest,
  target: RecoveryTarget,
  evidenceDigest: importDigest,
  cursor: Schema.String.check(Schema.isMaxLength(maximumImportCursorLength)),
  lastKey: Schema.String.check(Schema.isMaxLength(maximumLedgerKeyLength)),
  checkedCases: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  digest: importDigest,
  state: Schema.Literals(["Verifying", "Verified"]),
  providerIsolation: Schema.Literal("Unqualified"),
});
export type ErasureImportedCheckpoint = typeof ErasureImportedCheckpoint.Type;
export type ErasureImportedInput = Readonly<{
  target: SqliteBootstrapTarget;
  evidence: RecoveryClosedSourceEvidence;
  bucket: R2Bucket;
}>;

export const ErasureRecoveryDrain = Schema.Struct({
  pending: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  externalPending: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
});
export type ErasureRecoveryDrain = typeof ErasureRecoveryDrain.Type;

export const ErasureSourceRetirement = Schema.Struct({
  from: ErasureGeneration,
  retired: ErasureReference,
});
export type ErasureSourceRetirement = typeof ErasureSourceRetirement.Type;

/** Bounded frozen-source observation, not a final checkpoint or serving authorization. */
export const ErasureFrozenLedgerProgress = Schema.Struct({
  generation: ErasureReference,
  registryGeneration: ErasureGeneration,
  registryEtag: Schema.String.check(Schema.isBetweenLength(1, maximumLedgerKeyLength)),
  capturedAtMs: Schema.Int,
  cursor: Schema.String.check(Schema.isMaxLength(maximumImportCursorLength)),
  lastKey: Schema.String.check(Schema.isMaxLength(maximumLedgerKeyLength)),
  checkedCases: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  checkedRequiredCases: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  checkedRequests: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  requiredDigest: importDigest,
  requestsDigest: importDigest,
  requestCursor: Schema.String.check(Schema.isMaxLength(maximumLedgerKeyLength)),
  phase: Schema.Literals(["Ledger", "Requests"]),
  digest: importDigest,
  state: Schema.Literals(["Observing", "Observed"]),
  providerIsolation: Schema.Literal("Unqualified"),
});
export type ErasureFrozenLedgerProgress = typeof ErasureFrozenLedgerProgress.Type;
export type ErasureFrozenLedgerInput = Readonly<{
  db: D1Database;
  bucket: R2Bucket;
  generation: string;
  previous: Option.Option<ErasureFrozenLedgerProgress>;
}>;
