import type { ErasureOriginals, ErasureStore, ErasureUnavailable } from "../erasure-store/contract";
import type { Effect } from "effect";
import { type Option, Schema } from "effect";
import { WebSessionId } from "../../src/core/web-session/contract";
import { UserId } from "../../src/core/identity/contract";
import { ErasureCustodyEvidence, ErasureReference } from "../../src/core/erasure/contract";

const maximumOperatorLength = 256;
const maximumReleaseLength = 64;

const digestLength = 32;
export const erasureRegistryName = "erasure-registry-v1";
export type ErasureRegistryNamespace = Readonly<{
  getByName: (
    name: string,
    options?: DurableObjectNamespaceGetDurableObjectOptions
  ) => Pick<Fetcher, "fetch">;
}> &
  Partial<Pick<DurableObjectNamespace, "idFromName">>;
export const ErasureRegistryMigration = Schema.Struct({
  expectedRelease: Schema.String.check(Schema.isBetweenLength(1, maximumReleaseLength)),
  deadlineMs: Schema.Int,
  authority: Schema.Struct({
    permission: Schema.Literal("titular.erase"),
    operatorRef: Schema.String.check(Schema.isBetweenLength(1, maximumOperatorLength)),
    expiresAtMs: Schema.Int,
  }),
});
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

/** Independent recovery metadata only. This capability never owns private original material. */
export type ErasureRegistry = Readonly<{
  get: (key: string) => ReturnType<R2Bucket["get"]>;
  head: R2Bucket["head"];
  put: (
    key: string,
    value: string,
    options?: Readonly<{ onlyIf: Pick<R2Conditional, "etagMatches" | "etagDoesNotMatch"> }>
  ) => ReturnType<R2Bucket["head"]>;
  delete: (key: string) => ReturnType<R2Bucket["delete"]>;
  list: (
    options: Pick<R2ListOptions, "limit" | "prefix" | "cursor">
  ) => ReturnType<R2Bucket["list"]>;
}>;

export type ErasureRecoveryConfiguration = Readonly<{
  db: D1Database;
  bucket: Option.Option<ErasureRegistry>;
}>;
export type ErasureRegistryOwnerEnvironment = Readonly<{
  DB: D1Database;
  RELEASE_GIT_SHA: string;
}> &
  Partial<Readonly<{ ERASURE_BUCKET: R2Bucket; ERASURE_REGISTRY: ErasureRegistry }>>;
export type ErasureRegistryOwnerConfiguration<Environment extends ErasureRegistryOwnerEnvironment> =
  Readonly<{
    state: Readonly<{
      id: Pick<DurableObjectId, "name">;
      storage: Pick<DurableObjectStorage, "sql" | "transactionSync" | "sync">;
    }>;
    environment: Environment;
    read: (request: Request, environment: Environment) => Promise<Response>;
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
  Schema.Struct({ action: Schema.Literal("MigrateRegistry") }),
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
      ERASURE_REGISTRY: ErasureRegistry;
      ERASURE_REGISTRY_COORDINATOR: ErasureRegistryNamespace;
      RELEASE_GIT_SHA: string;
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
