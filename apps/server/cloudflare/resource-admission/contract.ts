import { Data, Schema } from "effect";

const maximumCharges = 16;
const maximumPolicies = 64;
const maximumGrantIdLength = 128;
const maximumPolicyKeyLength = 128;
const maximumScopeKeyLength = 256;

/** Stable identity of one versioned resource-admission policy. */
export const ResourceAdmissionPolicyKey = Schema.NonEmptyString.check(
  Schema.isMaxLength(maximumPolicyKeyLength)
)
  .pipe(Schema.brand("ResourceAdmissionPolicyKey"))
  .annotate({ identifier: "ResourceAdmissionPolicyKey" });
export type ResourceAdmissionPolicyKey = typeof ResourceAdmissionPolicyKey.Type;

/** Bounded coordination key for one policy scope; it is never authorization evidence. */
export const ResourceAdmissionScopeKey = Schema.NonEmptyString.check(
  Schema.isMaxLength(maximumScopeKeyLength)
)
  .pipe(Schema.brand("ResourceAdmissionScopeKey"))
  .annotate({ identifier: "ResourceAdmissionScopeKey" });
export type ResourceAdmissionScopeKey = typeof ResourceAdmissionScopeKey.Type;

/** Caller-generated identity of one exact atomic admission attempt. */
export const ResourceAdmissionGrantId = Schema.NonEmptyString.check(
  Schema.isMaxLength(maximumGrantIdLength)
)
  .pipe(Schema.brand("ResourceAdmissionGrantId"))
  .annotate({ identifier: "ResourceAdmissionGrantId" });
export type ResourceAdmissionGrantId = typeof ResourceAdmissionGrantId.Type;

/** Positive safe integer count used by an installed admission policy. */
export const ResourceAdmissionLimit = Schema.Int.check(Schema.isGreaterThan(0))
  .pipe(Schema.brand("ResourceAdmissionLimit"))
  .annotate({ identifier: "ResourceAdmissionLimit" });
export type ResourceAdmissionLimit = typeof ResourceAdmissionLimit.Type;

/** Positive safe integer amount charged by one admission attempt. */
export const ResourceAdmissionUnits = Schema.Int.check(Schema.isGreaterThan(0))
  .pipe(Schema.brand("ResourceAdmissionUnits"))
  .annotate({ identifier: "ResourceAdmissionUnits" });
export type ResourceAdmissionUnits = typeof ResourceAdmissionUnits.Type;

/** Positive safe integer duration used to derive a window or safety lease. */
export const ResourceAdmissionDurationMs = Schema.Int.check(Schema.isGreaterThan(0))
  .pipe(Schema.brand("ResourceAdmissionDurationMs"))
  .annotate({ identifier: "ResourceAdmissionDurationMs" });
export type ResourceAdmissionDurationMs = typeof ResourceAdmissionDurationMs.Type;

/** Non-negative safe integer UTC epoch millisecond owned by the Worker clock. */
export const ResourceAdmissionEpochMs = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))
  .pipe(Schema.brand("ResourceAdmissionEpochMs"))
  .annotate({ identifier: "ResourceAdmissionEpochMs" });
export type ResourceAdmissionEpochMs = typeof ResourceAdmissionEpochMs.Type;

/** Cloudflare authority dimension for security and resource controls, not commercial allowances. */
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
  /** Fixed UTC epoch used to align deterministic calendar boundaries. */
  originEpochMs: ResourceAdmissionEpochMs,
});

const OutstandingPolicy = Schema.Struct({
  dimension: Schema.Literal("outstanding_work"),
  key: ResourceAdmissionPolicyKey,
  kind: Schema.Literal("outstanding"),
  /** Safety lease after which abandoned work stops occupying capacity. */
  leaseMs: ResourceAdmissionDurationMs,
  limit: ResourceAdmissionLimit,
});

/** Immutable policy installed when the private Cloudflare Worker assembles its D1 authority. */
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

/** Non-empty, bounded policy inventory with one definition for each versioned policy key. */
export const ResourceAdmissionPolicies = Schema.NonEmptyArray(ResourceAdmissionPolicy)
  .check(Schema.isMaxLength(maximumPolicies), uniquePolicyKeys)
  .pipe(Schema.brand("ResourceAdmissionPolicies"))
  .annotate({ identifier: "ResourceAdmissionPolicies" });
export type ResourceAdmissionPolicies = typeof ResourceAdmissionPolicies.Type;

/** One use of an installed policy. Callers cannot choose its dimension, limit, or time window. */
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

/** Non-empty, bounded set of distinct policy charges in one atomic admission attempt. */
export const ResourceAdmissionCharges = Schema.NonEmptyArray(ResourceAdmissionCharge)
  .check(Schema.isMaxLength(maximumCharges), uniqueChargePolicyKeys)
  .pipe(Schema.brand("ResourceAdmissionCharges"))
  .annotate({ identifier: "ResourceAdmissionCharges" });
export type ResourceAdmissionCharges = typeof ResourceAdmissionCharges.Type;

/** A security/resource control refused work before an expensive or persistent effect began. */
export class ResourceAdmissionRefused extends Data.TaggedError("ResourceAdmissionRefused")<{
  readonly reason: "resource_limit";
}> {}

/** The Cloudflare admission authority could not make a trustworthy decision. */
export class ResourceAdmissionUnavailable extends Data.TaggedError("ResourceAdmissionUnavailable")<{
  readonly reason: "authority_unavailable";
}> {}

/** Durable identity returned after every claim and caller-owned statement commits atomically. */
export type ResourceAdmissionGrant = Readonly<{
  readonly grantId: ResourceAdmissionGrantId;
}>;

/** Complete atomic admission attempt assembled by the internal Worker adapter. */
export type ResourceAdmissionRequest = Readonly<{
  readonly charges: ResourceAdmissionCharges;
  readonly grantId: ResourceAdmissionGrantId;
  /**
   * D1 statements that must commit with admission, such as a proof/replay record or bounded outbox
   * publication. They execute after the grant exists and roll the complete admission back on error.
   */
  readonly statements: ReadonlyArray<D1PreparedStatement>;
}>;

/**
 * One bounded attempt before an expensive work claim. The attempt is charged even when work is
 * refused; neither its grant nor its units can be reused for a retry. Work still commits atomically
 * with its own proof/replay and publication statements. Callers check replay before this interface.
 */
export type ResourceAdmissionAttempt = Readonly<{
  readonly attempt: ResourceAdmissionRequest;
  readonly work: ResourceAdmissionRequest;
}>;

/** Atomic completion transition for a previously admitted outstanding-work grant. */
export type ReleaseOutstandingWorkRequest = Readonly<{
  readonly grantId: ResourceAdmissionGrantId;
  /** D1 statements whose state transition releases the outstanding work. */
  readonly statements: ReadonlyArray<D1PreparedStatement>;
}>;

/** Trusted Worker-owned dependencies and immutable policy installed into one authority. */
export type ResourceAdmissionAuthorityConfig = Readonly<{
  /** Private Core D1 binding; the authority never falls back to process-local usage state. */
  readonly database: D1Database;
  /** Cloudflare Worker-owned policy inventory; process memory never stores usage or grants. */
  readonly policies: ResourceAdmissionPolicies;
  /** Worker clock seam. Request callers cannot select decision time. */
  readonly nowEpochMs: () => ResourceAdmissionEpochMs;
}>;
