import { dual } from "effect/Function";
import { Effect, Option } from "effect";
import {
  type PreparedResourceAdmission,
  type ReleaseOutstandingWorkRequest,
  type ResourceAdmissionAttempt,
  type ResourceAdmissionAuthorityConfig,
  type ResourceAdmissionCharge,
  type ResourceAdmissionDimension,
  type ResourceAdmissionEpochMs,
  type ResourceAdmissionGrant,
  type ResourceAdmissionGrantId,
  type ResourceAdmissionLimit,
  type ResourceAdmissionPolicy,
  type ResourceAdmissionPolicyKey,
  ResourceAdmissionRefused,
  type ResourceAdmissionRequest,
  type ResourceAdmissionScopeKey,
  type ResourceAdmissionTransition,
  ResourceAdmissionUnavailable,
  type ResourceAdmissionUnits,
} from "./contract";

const refusalMarker = "resource_admission_refused";
const refusalFailurePattern = new RegExp(
  `^Error: D1_(?:EXEC_)?ERROR: ${refusalMarker}: SQLITE_CONSTRAINT` +
    String.raw`(?: \(extended: SQLITE_CONSTRAINT_TRIGGER\))?$`,
  "u"
);
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
  request: ResourceAdmissionTransition,
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

const executeBatch = (
  database: D1Database,
  statements: ReadonlyArray<D1PreparedStatement>
): Effect.Effect<
  ReadonlyArray<D1Result<unknown>>,
  ResourceAdmissionRefused | ResourceAdmissionUnavailable
> =>
  // D1 batch has no cancellation API. Shield it through settlement so interruption cannot detach a
  // still-running authority transaction from its caller and leave the durable outcome ambiguous.
  Effect.uninterruptible(
    Effect.tryPromise({
      try: () => database.batch([...statements]),
      catch: classifyResourceAdmissionFailure,
    })
  );

/** D1 exposes trigger provenance through this canonical SQLite extended-code error shape. */
export const classifyResourceAdmissionFailure = (
  cause: unknown
): ResourceAdmissionRefused | ResourceAdmissionUnavailable =>
  refusalFailurePattern.test(String(cause))
    ? new ResourceAdmissionRefused({ reason: "resource_limit" })
    : new ResourceAdmissionUnavailable({ reason: "authority_unavailable" });

/** Prepare complete admission for an owner-controlled atomic D1 commit; performs no I/O.
 * Unknown policies and unsafe timestamps are defects before any statements execute.
 */
export const prepareResourceAdmission = dual<
  (
    request: ResourceAdmissionTransition
  ) => (config: ResourceAdmissionAuthorityConfig) => PreparedResourceAdmission,
  (
    config: ResourceAdmissionAuthorityConfig,
    request: ResourceAdmissionTransition
  ) => PreparedResourceAdmission
>(2, (config, request) => {
  const nowEpochMs = config.nowEpochMs();
  const charges = resolveCharges(config.policies, request, nowEpochMs);
  if (Option.isNone(charges)) throw new TypeError("Invalid resource admission request");
  return {
    grantId: request.grantId,
    statements: [
      ...charges.value.map((charge) =>
        claimStatement({
          charge,
          database: config.database,
          grantId: request.grantId,
          nowEpochMs,
        })
      ),
      grantStatement({
        chargeCount: charges.value.length,
        database: config.database,
        grantId: request.grantId,
        nowEpochMs,
      }),
    ],
  };
});

/** Commit admission and caller statements together, waiting for D1 settlement on interruption. */
export const admitResource = dual<
  (
    request: ResourceAdmissionRequest
  ) => (
    config: ResourceAdmissionAuthorityConfig
  ) => Effect.Effect<
    ResourceAdmissionGrant,
    ResourceAdmissionRefused | ResourceAdmissionUnavailable
  >,
  (
    config: ResourceAdmissionAuthorityConfig,
    request: ResourceAdmissionRequest
  ) => Effect.Effect<
    ResourceAdmissionGrant,
    ResourceAdmissionRefused | ResourceAdmissionUnavailable
  >
>(2, (config, request) =>
  Effect.suspend(() => {
    const prepared = prepareResourceAdmission(config, request);
    return executeBatch(config.database, [...prepared.statements, ...request.statements]).pipe(
      Effect.as({ grantId: prepared.grantId })
    );
  })
);

/** Release outstanding occupancy with the caller's completion statements in the same D1 batch. */
export const releaseOutstandingResource = dual<
  (
    request: ReleaseOutstandingWorkRequest
  ) => (
    config: ResourceAdmissionAuthorityConfig
  ) => Effect.Effect<void, ResourceAdmissionUnavailable>,
  (
    config: ResourceAdmissionAuthorityConfig,
    request: ReleaseOutstandingWorkRequest
  ) => Effect.Effect<void, ResourceAdmissionUnavailable>
>(2, (config, request) => {
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
});

/** Charge bounded attempt pressure even when the subsequent atomic work admission is refused. */
export const admitResourceWithAttemptPressure = dual<
  (
    request: ResourceAdmissionAttempt
  ) => (
    config: ResourceAdmissionAuthorityConfig
  ) => Effect.Effect<
    ResourceAdmissionGrant,
    ResourceAdmissionRefused | ResourceAdmissionUnavailable
  >,
  (
    config: ResourceAdmissionAuthorityConfig,
    request: ResourceAdmissionAttempt
  ) => Effect.Effect<
    ResourceAdmissionGrant,
    ResourceAdmissionRefused | ResourceAdmissionUnavailable
  >
>(2, (config, { attempt, work }) =>
  admitResource(config, attempt).pipe(Effect.flatMap(() => admitResource(config, work)))
);
