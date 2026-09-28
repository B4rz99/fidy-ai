import { type Cause, Effect } from "effect";
import {
  ResourceAdmissionAuthority,
  ResourceAdmissionCharges,
  ResourceAdmissionDurationMs,
  ResourceAdmissionEpochMs,
  ResourceAdmissionGrantId,
  ResourceAdmissionLimit,
  ResourceAdmissionPolicies,
  ResourceAdmissionPolicyKey,
  ResourceAdmissionScopeKey,
  ResourceAdmissionUnits,
} from "../resource-admission/authority";
import { newId } from "../pats/pat-shared";

const windowMilliseconds = 3_600_000;
const userAttemptLimit = 24;
const globalAttemptLimit = 10_000;
const preparationWindowMs = ResourceAdmissionDurationMs.make(windowMilliseconds);
const oneUnit = ResourceAdmissionUnits.make(1);
const cardPreparationPolicies = ResourceAdmissionPolicies.make([
  {
    dimension: "stable_user",
    durationMs: preparationWindowMs,
    key: ResourceAdmissionPolicyKey.make("billing.card-preparation.attempt.user.v1"),
    kind: "rolling_window",
    limit: ResourceAdmissionLimit.make(userAttemptLimit),
  },
  {
    dimension: "operation",
    durationMs: preparationWindowMs,
    key: ResourceAdmissionPolicyKey.make("billing.card-preparation.attempt.global.v1"),
    kind: "rolling_window",
    limit: ResourceAdmissionLimit.make(globalAttemptLimit),
  },
]);

/** Count authenticated preparation attempts before the existing provider-work reservation. */
export const admitCardPreparationAttempt = ({
  db,
  userId,
  now,
}: Readonly<{ db: D1Database; userId: string; now: number }>): ReturnType<
  ReturnType<typeof ResourceAdmissionAuthority.make>["admit"]
> =>
  ResourceAdmissionAuthority.make({
    database: db,
    nowEpochMs: () => ResourceAdmissionEpochMs.make(now),
    policies: cardPreparationPolicies,
  }).admit({
    charges: ResourceAdmissionCharges.make([
      {
        policyKey: ResourceAdmissionPolicyKey.make("billing.card-preparation.attempt.user.v1"),
        scopeKey: ResourceAdmissionScopeKey.make(userId),
        units: oneUnit,
      },
      {
        policyKey: ResourceAdmissionPolicyKey.make("billing.card-preparation.attempt.global.v1"),
        scopeKey: ResourceAdmissionScopeKey.make("card-preparation"),
        units: oneUnit,
      },
    ]),
    grantId: ResourceAdmissionGrantId.make(`card-preparation-attempt-${newId()}`),
    statements: [],
  });

/** Sweep only expired, standalone attempt grants; work evidence belongs to CardEnrollment D1. */
export const sweepExpiredCardPreparationAdmission = ({
  db,
  now,
}: Readonly<{ db: D1Database; now: number }>): Effect.Effect<void, Cause.UnknownError> =>
  Effect.tryPromise(() =>
    db.batch([
      db
        .prepare(
          `DELETE FROM resource_admission_events WHERE grant_id IN (
           SELECT id FROM resource_admission_grants
           WHERE id LIKE 'card-preparation-attempt-%' AND admitted_at_epoch_ms <= ?
           ORDER BY admitted_at_epoch_ms LIMIT 128
         ) AND expires_at_epoch_ms <= ?`
        )
        .bind(now - preparationWindowMs, now),
      db
        .prepare(
          `DELETE FROM resource_admission_grants
         WHERE id LIKE 'card-preparation-attempt-%' AND admitted_at_epoch_ms <= ?
           AND NOT EXISTS (SELECT 1 FROM resource_admission_events e WHERE e.grant_id = id)`
        )
        .bind(now - preparationWindowMs),
    ])
  ).pipe(Effect.asVoid);
