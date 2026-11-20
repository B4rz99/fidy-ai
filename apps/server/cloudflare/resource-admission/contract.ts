import type { OwnedStatement } from "../../src/shell/owner-write/contract";
import { Data, Schema } from "effect";
import type { UserId } from "../../src/core/identity/contract";
import type { WebSessionId } from "../../src/core/web-session/contract";

const maximumCharges = 16;
const maximumPolicies = 64;
const maximumGrantIdLength = 128;
const maximumPolicyKeyLength = 128;
const maximumScopeKeyLength = 256;

export const ResourceAdmissionPolicyKey = Schema.NonEmptyString.check(
  Schema.isMaxLength(maximumPolicyKeyLength)
)
  .pipe(Schema.brand("ResourceAdmissionPolicyKey"))
  .annotate({ identifier: "ResourceAdmissionPolicyKey" });
export type ResourceAdmissionPolicyKey = typeof ResourceAdmissionPolicyKey.Type;

export const ResourceAdmissionScopeKey = Schema.NonEmptyString.check(
  Schema.isMaxLength(maximumScopeKeyLength)
)
  .pipe(Schema.brand("ResourceAdmissionScopeKey"))
  .annotate({ identifier: "ResourceAdmissionScopeKey" });
export type ResourceAdmissionScopeKey = typeof ResourceAdmissionScopeKey.Type;

export const ResourceAdmissionGrantId = Schema.NonEmptyString.check(
  Schema.isMaxLength(maximumGrantIdLength)
)
  .pipe(Schema.brand("ResourceAdmissionGrantId"))
  .annotate({ identifier: "ResourceAdmissionGrantId" });
export type ResourceAdmissionGrantId = typeof ResourceAdmissionGrantId.Type;

export const ResourceAdmissionLimit = Schema.Int.check(Schema.isGreaterThan(0))
  .pipe(Schema.brand("ResourceAdmissionLimit"))
  .annotate({ identifier: "ResourceAdmissionLimit" });
export type ResourceAdmissionLimit = typeof ResourceAdmissionLimit.Type;

export const ResourceAdmissionUnits = Schema.Int.check(Schema.isGreaterThan(0))
  .pipe(Schema.brand("ResourceAdmissionUnits"))
  .annotate({ identifier: "ResourceAdmissionUnits" });
export type ResourceAdmissionUnits = typeof ResourceAdmissionUnits.Type;

export const ResourceAdmissionDurationMs = Schema.Int.check(Schema.isGreaterThan(0))
  .pipe(Schema.brand("ResourceAdmissionDurationMs"))
  .annotate({ identifier: "ResourceAdmissionDurationMs" });
export type ResourceAdmissionDurationMs = typeof ResourceAdmissionDurationMs.Type;

export const ResourceAdmissionEpochMs = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))
  .pipe(Schema.brand("ResourceAdmissionEpochMs"))
  .annotate({ identifier: "ResourceAdmissionEpochMs" });
export type ResourceAdmissionEpochMs = typeof ResourceAdmissionEpochMs.Type;

export const ResourceAdmissionDimension = Schema.Literals([
  "stable_user",
  "source",
  "operation",
  "outstanding_work",
  "spend",
]);
export type ResourceAdmissionDimension = typeof ResourceAdmissionDimension.Type;

const WindowedDimension = Schema.Literals(["stable_user", "source", "operation", "spend"]);

const RollingWindowPolicy = Schema.Struct({
  dimension: WindowedDimension,
  durationMs: ResourceAdmissionDurationMs,
  key: ResourceAdmissionPolicyKey,
  kind: Schema.Literal("rolling_window"),
  limit: ResourceAdmissionLimit,
});

const CalendarWindowPolicy = Schema.Struct({
  dimension: WindowedDimension,
  durationMs: ResourceAdmissionDurationMs,
  key: ResourceAdmissionPolicyKey,
  kind: Schema.Literal("calendar_window"),
  limit: ResourceAdmissionLimit,
  originEpochMs: ResourceAdmissionEpochMs,
});

const OutstandingPolicy = Schema.Struct({
  dimension: Schema.Literal("outstanding_work"),
  key: ResourceAdmissionPolicyKey,
  kind: Schema.Literal("outstanding"),
  leaseMs: ResourceAdmissionDurationMs,
  limit: ResourceAdmissionLimit,
});

export const ResourceAdmissionPolicy = Schema.Union([
  RollingWindowPolicy,
  CalendarWindowPolicy,
  OutstandingPolicy,
]);
export type ResourceAdmissionPolicy = typeof ResourceAdmissionPolicy.Type;

const uniquePolicyKeys = Schema.makeFilter<ReadonlyArray<ResourceAdmissionPolicy>>((policies) =>
  new Set(policies.map(({ key }) => key)).size === policies.length
    ? undefined
    : "Expected unique resource-admission policy keys"
);

export const ResourceAdmissionPolicies = Schema.NonEmptyArray(ResourceAdmissionPolicy)
  .check(Schema.isMaxLength(maximumPolicies), uniquePolicyKeys)
  .pipe(Schema.brand("ResourceAdmissionPolicies"))
  .annotate({ identifier: "ResourceAdmissionPolicies" });
export type ResourceAdmissionPolicies = typeof ResourceAdmissionPolicies.Type;

export const ResourceAdmissionCharge = Schema.Struct({
  policyKey: ResourceAdmissionPolicyKey,
  scopeKey: ResourceAdmissionScopeKey,
  units: ResourceAdmissionUnits,
});
export type ResourceAdmissionCharge = typeof ResourceAdmissionCharge.Type;

const uniqueChargePolicyKeys = Schema.makeFilter<ReadonlyArray<ResourceAdmissionCharge>>(
  (charges) =>
    new Set(charges.map(({ policyKey }) => policyKey)).size === charges.length
      ? undefined
      : "Expected at most one resource-admission charge per policy"
);

export const ResourceAdmissionCharges = Schema.NonEmptyArray(ResourceAdmissionCharge)
  .check(Schema.isMaxLength(maximumCharges), uniqueChargePolicyKeys)
  .pipe(Schema.brand("ResourceAdmissionCharges"))
  .annotate({ identifier: "ResourceAdmissionCharges" });
export type ResourceAdmissionCharges = typeof ResourceAdmissionCharges.Type;

export class ResourceAdmissionRefused extends Data.TaggedError("ResourceAdmissionRefused")<{
  readonly reason: "resource_limit";
}> {}

export class ResourceAdmissionUnavailable extends Data.TaggedError("ResourceAdmissionUnavailable")<{
  readonly reason: "authority_unavailable";
}> {}

export type ResourceAdmissionGrant = Readonly<{
  readonly grantId: ResourceAdmissionGrantId;
}>;

export type ResourceAdmissionResult = ResourceAdmissionGrant &
  Readonly<{ results: ReadonlyArray<D1Result> }>;

export type PreparedResourceAdmission = ResourceAdmissionGrant &
  Readonly<{
    statements: ReadonlyArray<D1PreparedStatement>;
  }>;

export type ResourceAdmissionTransition = Readonly<{
  charges: ResourceAdmissionCharges;
  grantId: ResourceAdmissionGrantId;
}>;

export type ResourceAdmissionRequest = ResourceAdmissionTransition &
  Readonly<{
    readonly statements: ReadonlyArray<D1PreparedStatement>;
  }>;

export type ResourceAdmissionAttempt = Readonly<{
  readonly attempt: ResourceAdmissionRequest;
  readonly work: ResourceAdmissionRequest;
}>;

export type ReleaseOutstandingWorkRequest = Readonly<{
  readonly grantId: ResourceAdmissionGrantId;
  readonly statements: ReadonlyArray<D1PreparedStatement>;
}>;

export type ResourceAdmissionAuthorityConfig = Readonly<{
  readonly database: D1Database;
  readonly policies: ResourceAdmissionPolicies;
  readonly nowEpochMs: () => ResourceAdmissionEpochMs;
}>;

export type ResourceAdmissionEventOwner =
  | Readonly<{ kind: "user"; userId: UserId }>
  | Readonly<{ kind: "web_session"; userId: UserId; sessionId: WebSessionId }>;

export type ResourceAdmissionCounterTransition =
  | Readonly<{
      kind: "email_pairing_user";
      userId: UserId;
    }>
  | Readonly<{ kind: "email_pairing_global" }>
  | Readonly<{
      kind: "email_replacement";
      userId: UserId;
      workId: string;
    }>
  | Readonly<{
      kind: "pat_pairing_source";
      sourceDigest: Uint8Array;
    }>
  | Readonly<{
      kind: "hosted_compaction";
      userId: UserId;
    }>;

export type EmailCounterKind = Extract<
  ResourceAdmissionCounterTransition,
  {
    kind: "email_pairing_user" | "email_pairing_global" | "email_replacement";
  }
>["kind"];

export type ResourceCounterRequest = Readonly<{
  db: D1Database;
  subject: OwnedStatement;
  current: number;
}> &
  (
    | Readonly<{ kind: "email_pairing_user" | "email_pairing_global" }>
    | Readonly<{ kind: "email_replacement"; workId: string }>
    | Readonly<{ kind: "pat_pairing_source"; sourceDigest: Uint8Array }>
    | Readonly<{ kind: "hosted_compaction" }>
  );

export type ResourceCounterQuery =
  | Readonly<{ kind: "email_pairing_global" }>
  | Readonly<{ kind: "email_pairing_user" | "email_replacement"; subject: OwnedStatement }>;

export const ProviderSpend = Schema.Struct({
  phase: Schema.Literals(["model", "reminderGeneration", "reminderSend"]),
  units: Schema.Int.check(Schema.isGreaterThan(0)),
});
export const providerAllowanceUrl = "https://directory.invalid/provider-allowance";
export const providerAllowanceSchema = [
  "CREATE TABLE provider_spend_attempts(phase TEXT NOT NULL,at_ms INTEGER NOT NULL,units INTEGER NOT NULL CHECK(units>=0)) STRICT",
  "CREATE INDEX provider_spend_by_phase ON provider_spend_attempts(phase,at_ms,units)",
  "CREATE INDEX provider_spend_expiry ON provider_spend_attempts(at_ms)",
] as const;
