import { type DateTime, Effect } from "effect";
import { type UserId } from "../../../src/core/identity/contract";
import { admitResource } from "../../resource-admission/operations";
import {
  ResourceAdmissionCharges,
  ResourceAdmissionDurationMs,
  ResourceAdmissionEpochMs,
  ResourceAdmissionGrantId,
  ResourceAdmissionLimit,
  ResourceAdmissionPolicies,
  ResourceAdmissionPolicyKey,
  ResourceAdmissionScopeKey,
  ResourceAdmissionUnits,
} from "../../resource-admission/contract";
import { newId } from "../../secret-material/operations";
import { InsightUnavailable } from "../contract";

const admissionWindowMs = 86_400_000;
const maximumUserAttempts = 32;
const maximumGlobalGenerations = 100_000;
const maximumGlobalSends = 10_000;
const maximumTemplateBytes = 4096;
const maximumGlobalSpendBytes = maximumGlobalSends * maximumTemplateBytes;
const day = ResourceAdmissionDurationMs.make(admissionWindowMs);
const policies = ResourceAdmissionPolicies.make([
  {
    key: ResourceAdmissionPolicyKey.make("weekly.generation.user.v1"),
    dimension: "stable_user",
    kind: "rolling_window",
    durationMs: day,
    limit: ResourceAdmissionLimit.make(maximumUserAttempts),
  },
  {
    key: ResourceAdmissionPolicyKey.make("weekly.generation.global.v1"),
    dimension: "operation",
    kind: "rolling_window",
    durationMs: day,
    limit: ResourceAdmissionLimit.make(maximumGlobalGenerations),
  },
  {
    key: ResourceAdmissionPolicyKey.make("weekly.send.user.v1"),
    dimension: "stable_user",
    kind: "rolling_window",
    durationMs: day,
    limit: ResourceAdmissionLimit.make(maximumUserAttempts),
  },
  {
    key: ResourceAdmissionPolicyKey.make("weekly.send.global.v1"),
    dimension: "operation",
    kind: "rolling_window",
    durationMs: day,
    limit: ResourceAdmissionLimit.make(maximumGlobalSends),
  },
  {
    key: ResourceAdmissionPolicyKey.make("weekly.send.spend.v1"),
    dimension: "spend",
    kind: "rolling_window",
    durationMs: day,
    limit: ResourceAdmissionLimit.make(maximumGlobalSpendBytes),
  },
]);

/** Provider-spend and stable-User pressure are authority, never commercial Free allowances.
 * Each send conservatively reserves the full 4096-byte template ceiling before its one-shot claim.
 */
export const admitWeeklyResource = (
  input: Readonly<{
    db: D1Database;
    userId: UserId;
    now: DateTime.Utc;
    phase: "generation" | "send";
  }>
): Effect.Effect<void, InsightUnavailable> => {
  const charges = ResourceAdmissionCharges.make([
    {
      policyKey: ResourceAdmissionPolicyKey.make(`weekly.${input.phase}.user.v1`),
      scopeKey: ResourceAdmissionScopeKey.make(input.userId),
      units: ResourceAdmissionUnits.make(1),
    },
    {
      policyKey: ResourceAdmissionPolicyKey.make(`weekly.${input.phase}.global.v1`),
      scopeKey: ResourceAdmissionScopeKey.make("weekly"),
      units: ResourceAdmissionUnits.make(1),
    },
    ...(input.phase === "send"
      ? [
          {
            policyKey: ResourceAdmissionPolicyKey.make("weekly.send.spend.v1"),
            scopeKey: ResourceAdmissionScopeKey.make("weekly"),
            units: ResourceAdmissionUnits.make(maximumTemplateBytes),
          },
        ]
      : []),
  ]);
  return admitResource(
    {
      database: input.db,
      policies,
      nowEpochMs: () => ResourceAdmissionEpochMs.make(input.now.epochMilliseconds),
    },
    {
      charges,
      grantId: ResourceAdmissionGrantId.make(`weekly-${newId()}`),
      statements: [],
    }
  ).pipe(
    Effect.asVoid,
    Effect.mapError(() => new InsightUnavailable())
  );
};
