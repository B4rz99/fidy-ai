import { type Effect } from "effect";
import { admitResourceWithAttemptPressure } from "../../resource-admission/operations";
import {
  type ResourceAdmissionAuthorityConfig,
  ResourceAdmissionCharges,
  ResourceAdmissionDurationMs,
  ResourceAdmissionEpochMs,
  type ResourceAdmissionGrant,
  ResourceAdmissionGrantId,
  ResourceAdmissionLimit,
  ResourceAdmissionPolicies,
  ResourceAdmissionPolicyKey,
  type ResourceAdmissionRefused,
  ResourceAdmissionScopeKey,
  type ResourceAdmissionUnavailable,
  ResourceAdmissionUnits,
} from "../../resource-admission/contract";
import { newIngestionId } from "./statement-staging";

export const uploadWindowMilliseconds = 3_600_000;
export const uploadLeaseMilliseconds = 600_000;
const oneUnit = ResourceAdmissionUnits.make(1);
const maximumUserAttempts = 40;
const maximumGlobalAttempts = 1000;
const maximumUserUploads = 20;
const maximumGlobalUploads = 500;
const policies = ResourceAdmissionPolicies.make([
  {
    dimension: "stable_user",
    durationMs: ResourceAdmissionDurationMs.make(uploadWindowMilliseconds),
    key: ResourceAdmissionPolicyKey.make("ingestion.upload.attempt.user.v1"),
    kind: "rolling_window",
    limit: ResourceAdmissionLimit.make(maximumUserAttempts),
  },
  {
    dimension: "operation",
    durationMs: ResourceAdmissionDurationMs.make(uploadWindowMilliseconds),
    key: ResourceAdmissionPolicyKey.make("ingestion.upload.attempt.global.v1"),
    kind: "rolling_window",
    limit: ResourceAdmissionLimit.make(maximumGlobalAttempts),
  },
  {
    dimension: "stable_user",
    durationMs: ResourceAdmissionDurationMs.make(uploadWindowMilliseconds),
    key: ResourceAdmissionPolicyKey.make("ingestion.upload.user.v1"),
    kind: "rolling_window",
    limit: ResourceAdmissionLimit.make(maximumUserUploads),
  },
  {
    dimension: "operation",
    durationMs: ResourceAdmissionDurationMs.make(uploadWindowMilliseconds),
    key: ResourceAdmissionPolicyKey.make("ingestion.upload.operation.v1"),
    kind: "rolling_window",
    limit: ResourceAdmissionLimit.make(maximumGlobalUploads),
  },
  {
    dimension: "spend",
    durationMs: ResourceAdmissionDurationMs.make(uploadWindowMilliseconds),
    key: ResourceAdmissionPolicyKey.make("ingestion.upload.spend.v1"),
    kind: "rolling_window",
    limit: ResourceAdmissionLimit.make(maximumGlobalUploads),
  },
  {
    dimension: "outstanding_work",
    key: ResourceAdmissionPolicyKey.make("ingestion.upload.outstanding.v1"),
    kind: "outstanding",
    leaseMs: ResourceAdmissionDurationMs.make(uploadLeaseMilliseconds),
    limit: ResourceAdmissionLimit.make(2),
  },
]);

/** One installed upload inventory for all credential/channel admission paths. */
export const statementUploadAuthority = ({
  db,
  current,
}: Readonly<{ db: D1Database; current: number }>): ResourceAdmissionAuthorityConfig => ({
  database: db,
  nowEpochMs: () => ResourceAdmissionEpochMs.make(current),
  policies,
});
const charge = (policyKey: string, scopeKey: string): ResourceAdmissionCharges[number] => ({
  policyKey: ResourceAdmissionPolicyKey.make(policyKey),
  scopeKey: ResourceAdmissionScopeKey.make(scopeKey),
  units: oneUnit,
});
/** Attempts remain charged on refusal; work and the caller-owned proof commit together. */
export const admitStatementUpload = ({
  db,
  userId,
  current,
  statements,
}: Readonly<{
  db: D1Database;
  userId: string;
  current: number;
  statements: (grantId: ResourceAdmissionGrantId) => ReadonlyArray<D1PreparedStatement>;
}>): Effect.Effect<
  ResourceAdmissionGrant,
  ResourceAdmissionRefused | ResourceAdmissionUnavailable
> => {
  const grantId = ResourceAdmissionGrantId.make(`ingestion-upload-work-${newIngestionId()}`);
  return admitResourceWithAttemptPressure(statementUploadAuthority({ db, current }), {
    attempt: {
      charges: ResourceAdmissionCharges.make([
        charge("ingestion.upload.attempt.user.v1", userId),
        charge("ingestion.upload.attempt.global.v1", "statement-staging"),
      ]),
      grantId: ResourceAdmissionGrantId.make(`ingestion-upload-attempt-${newIngestionId()}`),
      statements: [],
    },
    work: {
      charges: ResourceAdmissionCharges.make([
        charge("ingestion.upload.user.v1", userId),
        charge("ingestion.upload.operation.v1", "statement-staging"),
        charge("ingestion.upload.spend.v1", "r2-statement-staging"),
        charge("ingestion.upload.outstanding.v1", userId),
      ]),
      grantId,
      statements: statements(grantId),
    },
  });
};
