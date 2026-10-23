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
export const ErasureGeneration = Schema.Union([Schema.Literal("initial"), ErasureReference]);

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
export type ErasureOperatorEnvironment = Readonly<{
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
