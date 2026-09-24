import { Context, Data, Effect, Layer, Option, Schema } from "effect";

const refusalMarker = "resource_admission_refused";
const refusalFailurePattern = new RegExp(
  `^Error: D1_(?:EXEC_)?ERROR: ${refusalMarker}: SQLITE_CONSTRAINT` +
    String.raw`(?: \(extended: SQLITE_CONSTRAINT_TRIGGER\))?$`,
  "u"
);
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

/** Atomic completion transition for a previously admitted outstanding-work grant. */
export type ReleaseOutstandingWorkRequest = Readonly<{
  readonly grantId: ResourceAdmissionGrantId;
  /** D1 statements whose state transition releases the outstanding work. */
  readonly statements: ReadonlyArray<D1PreparedStatement>;
}>;

/**
 * D1 authority for resource admission. Refusals are policy decisions; unavailable failures mean no
 * trustworthy decision was returned. D1 batches settle before fiber interruption completes.
 */
export type ResourceAdmissionAuthorityService = Readonly<{
  /** Atomically claims every policy and commits the caller-owned statements. */
  readonly admit: (
    request: ResourceAdmissionRequest
  ) => Effect.Effect<
    ResourceAdmissionGrant,
    ResourceAdmissionRefused | ResourceAdmissionUnavailable
  >;
  /** Releases only outstanding-work occupancy with the caller-owned completion transition. */
  readonly releaseOutstandingWork: (
    request: ReleaseOutstandingWorkRequest
  ) => Effect.Effect<void, ResourceAdmissionUnavailable>;
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

type ResolvedChargeCommon = Readonly<{
  readonly dimension: ResourceAdmissionDimension;
  readonly expiresAtEpochMs: number;
  readonly limit: ResourceAdmissionLimit;
  readonly policyKey: ResourceAdmissionPolicyKey;
  readonly scopeKey: ResourceAdmissionScopeKey;
  readonly units: ResourceAdmissionUnits;
}>;

type ResolvedCharge =
  | (ResolvedChargeCommon & Readonly<{ readonly kind: "outstanding" }>)
  | (ResolvedChargeCommon &
      Readonly<{
        readonly kind: "rolling_window" | "calendar_window";
        readonly windowStartEpochMs: number;
      }>);

const isSafeEpoch = (value: number): boolean => Number.isSafeInteger(value) && value >= 0;

const invalidRequestDefect = (): Effect.Effect<never> =>
  Effect.die(new TypeError("Invalid resource admission request"));

const resolveCharge = (
  policies: ReadonlyArray<ResourceAdmissionPolicy>,
  charge: ResourceAdmissionCharge,
  nowEpochMs: ResourceAdmissionEpochMs
): Option.Option<ResolvedCharge> =>
  Option.flatMap(
    Option.fromUndefinedOr(policies.find((candidate) => candidate.key === charge.policyKey)),
    (policy): Option.Option<ResolvedCharge> => {
      if (charge.units > policy.limit) return Option.none();
      if (policy.kind === "outstanding") {
        const expiresAtEpochMs = nowEpochMs + policy.leaseMs;
        if (!isSafeEpoch(expiresAtEpochMs)) return Option.none();
        return Option.some({
          dimension: policy.dimension,
          expiresAtEpochMs,
          kind: policy.kind,
          limit: policy.limit,
          policyKey: policy.key,
          scopeKey: charge.scopeKey,
          units: charge.units,
        });
      }

      const windowStartEpochMs =
        policy.kind === "rolling_window"
          ? Math.max(0, nowEpochMs - policy.durationMs)
          : policy.originEpochMs +
            Math.floor((nowEpochMs - policy.originEpochMs) / policy.durationMs) * policy.durationMs;
      const expiresAtEpochMs =
        policy.kind === "rolling_window"
          ? nowEpochMs + policy.durationMs
          : windowStartEpochMs + policy.durationMs;
      if (!isSafeEpoch(windowStartEpochMs) || !isSafeEpoch(expiresAtEpochMs)) return Option.none();
      return Option.some({
        dimension: policy.dimension,
        expiresAtEpochMs,
        kind: policy.kind,
        limit: policy.limit,
        policyKey: policy.key,
        scopeKey: charge.scopeKey,
        units: charge.units,
        windowStartEpochMs,
      });
    }
  );

const resolveCharges = (
  policies: ReadonlyArray<ResourceAdmissionPolicy>,
  request: ResourceAdmissionRequest,
  nowEpochMs: ResourceAdmissionEpochMs
): Option.Option<ReadonlyArray<ResolvedCharge>> => {
  if (!isSafeEpoch(nowEpochMs)) return Option.none();
  return Option.all(request.charges.map((charge) => resolveCharge(policies, charge, nowEpochMs)));
};

type ClaimStatementInput = Readonly<{
  readonly charge: ResolvedCharge;
  readonly database: D1Database;
  readonly grantId: ResourceAdmissionGrantId;
  readonly nowEpochMs: ResourceAdmissionEpochMs;
}>;

const prepareClaimInsert = (input: ClaimStatementInput): D1PreparedStatement => {
  const activeWindowComparison =
    input.charge.kind === "rolling_window"
      ? "admitted_at_epoch_ms > ?"
      : "admitted_at_epoch_ms >= ?";
  return input.database.prepare(
    `INSERT INTO resource_admission_events (
      grant_id, policy_key, dimension, scope_key, policy_kind, units,
      admitted_at_epoch_ms, window_start_epoch_ms, expires_at_epoch_ms, released_at_epoch_ms
    )
    SELECT ?, ?, ?, ?, ?, ?, ?, CASE WHEN ? = 'outstanding' THEN NULL ELSE ? END, ?, NULL
    WHERE (
      SELECT coalesce(sum(units), 0)
      FROM resource_admission_events
      WHERE policy_key = ?
        AND dimension = ?
        AND scope_key = ?
        AND released_at_epoch_ms IS NULL
        AND expires_at_epoch_ms > ?
        AND (${activeWindowComparison} OR ? = 'outstanding')
    ) + ? <= ?`
  );
};

const claimStatement = (input: ClaimStatementInput): D1PreparedStatement => {
  const statement = prepareClaimInsert(input);
  const windowStartEpochMs =
    input.charge.kind === "outstanding" ? input.nowEpochMs : input.charge.windowStartEpochMs;
  return statement.bind(
    input.grantId,
    input.charge.policyKey,
    input.charge.dimension,
    input.charge.scopeKey,
    input.charge.kind,
    input.charge.units,
    input.nowEpochMs,
    input.charge.kind,
    windowStartEpochMs,
    input.charge.expiresAtEpochMs,
    input.charge.policyKey,
    input.charge.dimension,
    input.charge.scopeKey,
    input.nowEpochMs,
    windowStartEpochMs,
    input.charge.kind,
    input.charge.units,
    input.charge.limit
  );
};

const grantStatement = (
  input: Readonly<{
    readonly chargeCount: number;
    readonly database: D1Database;
    readonly grantId: ResourceAdmissionGrantId;
    readonly nowEpochMs: ResourceAdmissionEpochMs;
  }>
): D1PreparedStatement =>
  input.database
    .prepare(
      `INSERT INTO resource_admission_grants (id, admitted_at_epoch_ms, claim_count)
       VALUES (?, ?, ?)`
    )
    .bind(input.grantId, input.nowEpochMs, input.chargeCount);

class D1BatchFailure extends Data.TaggedError("D1BatchFailure")<{
  readonly cause: unknown;
}> {}

/**
 * This primitive deliberately adds no nested span: the caller's bounded Work span owns admission
 * latency and outcome, avoiding duplicate traces without safe subject attributes at this SQL seam.
 */
const executeBatch = (
  database: D1Database,
  statements: ReadonlyArray<D1PreparedStatement>
): Effect.Effect<ReadonlyArray<D1Result<unknown>>, D1BatchFailure> =>
  // D1 batch has no cancellation API. Shield it through settlement so interruption cannot detach a
  // still-running authority transaction from its caller and leave the durable outcome ambiguous.
  Effect.uninterruptible(
    Effect.tryPromise({
      try: () => database.batch([...statements]),
      catch: (cause) => new D1BatchFailure({ cause }),
    })
  );

/** D1 exposes trigger provenance through this canonical SQLite extended-code error shape. */
const classifyAdmissionFailure = (
  failure: D1BatchFailure
): ResourceAdmissionRefused | ResourceAdmissionUnavailable =>
  refusalFailurePattern.test(String(failure.cause))
    ? new ResourceAdmissionRefused({ reason: "resource_limit" })
    : new ResourceAdmissionUnavailable({ reason: "authority_unavailable" });

/**
 * Installs immutable policy with the private Worker's D1 authority. Callers must supply branded
 * policy/charge collections and caller-owned statements prepared from the same D1 binding. Unknown
 * policies, charges above an installed limit, or unsafe derived timestamps die before SQL begins.
 * Every batch settles before interruption completes; every decision and grant remains in D1, while
 * the in-process policy inventory is configuration rather than a usage-state fallback.
 */
const makeResourceAdmissionAuthorityService = (
  config: ResourceAdmissionAuthorityConfig
): ResourceAdmissionAuthorityService => {
  const admit: ResourceAdmissionAuthorityService["admit"] = (request) => {
    const nowEpochMs = config.nowEpochMs();
    return Option.match(resolveCharges(config.policies, request, nowEpochMs), {
      onNone: invalidRequestDefect,
      onSome: (charges) =>
        executeBatch(config.database, [
          ...charges.map((charge) =>
            claimStatement({
              charge,
              database: config.database,
              grantId: request.grantId,
              nowEpochMs,
            })
          ),
          grantStatement({
            chargeCount: charges.length,
            database: config.database,
            grantId: request.grantId,
            nowEpochMs,
          }),
          ...request.statements,
        ]).pipe(Effect.mapError(classifyAdmissionFailure), Effect.as({ grantId: request.grantId })),
    });
  };

  const releaseOutstandingWork: ResourceAdmissionAuthorityService["releaseOutstandingWork"] = (
    request
  ) => {
    const releasedAtEpochMs = config.nowEpochMs();
    if (!isSafeEpoch(releasedAtEpochMs)) return invalidRequestDefect();
    return executeBatch(config.database, [
      config.database
        .prepare(
          `UPDATE resource_admission_events
           SET released_at_epoch_ms = ?
           WHERE grant_id = ?
             AND dimension = 'outstanding_work'
             AND released_at_epoch_ms IS NULL`
        )
        .bind(releasedAtEpochMs, request.grantId),
      ...request.statements,
    ]).pipe(
      Effect.mapError(() => new ResourceAdmissionUnavailable({ reason: "authority_unavailable" })),
      Effect.asVoid
    );
  };

  return { admit, releaseOutstandingWork };
};

/** Substitutable D1 resource-admission authority assembled by the private Core Worker. */
export class ResourceAdmissionAuthority extends Context.Service<
  ResourceAdmissionAuthority,
  ResourceAdmissionAuthorityService
>()("@fidy/server/cloudflare/resource-admission/authority/ResourceAdmissionAuthority") {
  /** Constructs an authority value for direct Worker adapter composition. */
  static readonly make = (
    config: ResourceAdmissionAuthorityConfig
  ): ResourceAdmissionAuthorityService => this.of(makeResourceAdmissionAuthorityService(config));

  /** Primary production layer parameterized by the Core Worker's D1 binding and immutable policy. */
  static readonly layer = (
    config: ResourceAdmissionAuthorityConfig
  ): Layer.Layer<ResourceAdmissionAuthority> => Layer.succeed(this, this.make(config));
}
