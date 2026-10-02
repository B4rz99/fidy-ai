import { newId } from "../../secret-material/operations";
import {
  type ResourceAdmissionAttempt,
  ResourceAdmissionCharges,
  ResourceAdmissionDurationMs,
  ResourceAdmissionGrantId,
  ResourceAdmissionLimit,
  ResourceAdmissionPolicies,
  ResourceAdmissionPolicyKey,
  ResourceAdmissionScopeKey,
  ResourceAdmissionUnits,
} from "../../resource-admission/authority";

export const workersAiAdmissionWindowMs = 86_400_000;
const oneDay = ResourceAdmissionDurationMs.make(workersAiAdmissionWindowMs);
const maximumUserAttempts = 500;
const maximumGlobalAttempts = 50_000;
const maximumUserSpend = 32_000_000;
const maximumGlobalSpend = 512_000_000;
const oneUnit = ResourceAdmissionUnits.make(1);
// Byte length conservatively bounds ordinary prompt tokens; output is reserved at max_tokens.
// These are resource-spend ceilings, never commercial Free allowances.
export const workersAiPolicies = ResourceAdmissionPolicies.make([
  {
    dimension: "stable_user",
    durationMs: oneDay,
    key: ResourceAdmissionPolicyKey.make("workers-ai.attempt.user.v1"),
    kind: "rolling_window",
    limit: ResourceAdmissionLimit.make(maximumUserAttempts),
  },
  {
    dimension: "operation",
    durationMs: oneDay,
    key: ResourceAdmissionPolicyKey.make("workers-ai.attempt.global.v1"),
    kind: "rolling_window",
    limit: ResourceAdmissionLimit.make(maximumGlobalAttempts),
  },
  {
    dimension: "spend",
    durationMs: oneDay,
    key: ResourceAdmissionPolicyKey.make("workers-ai.spend.user.v1"),
    kind: "rolling_window",
    limit: ResourceAdmissionLimit.make(maximumUserSpend),
  },
  {
    dimension: "spend",
    durationMs: oneDay,
    key: ResourceAdmissionPolicyKey.make("workers-ai.spend.global.v1"),
    kind: "rolling_window",
    limit: ResourceAdmissionLimit.make(maximumGlobalSpend),
  },
]);

export const spendRequest = ({
  userId,
  cost,
}: Readonly<{ userId: string; cost: ResourceAdmissionUnits }>): ResourceAdmissionAttempt => ({
  attempt: {
    charges: ResourceAdmissionCharges.make([
      {
        policyKey: ResourceAdmissionPolicyKey.make("workers-ai.attempt.user.v1"),
        scopeKey: ResourceAdmissionScopeKey.make(userId),
        units: oneUnit,
      },
      {
        policyKey: ResourceAdmissionPolicyKey.make("workers-ai.attempt.global.v1"),
        scopeKey: ResourceAdmissionScopeKey.make("workers-ai"),
        units: oneUnit,
      },
    ]),
    grantId: ResourceAdmissionGrantId.make(`workers-ai-attempt-${newId()}`),
    statements: [],
  },
  work: {
    charges: ResourceAdmissionCharges.make([
      {
        policyKey: ResourceAdmissionPolicyKey.make("workers-ai.spend.user.v1"),
        scopeKey: ResourceAdmissionScopeKey.make(userId),
        units: cost,
      },
      {
        policyKey: ResourceAdmissionPolicyKey.make("workers-ai.spend.global.v1"),
        scopeKey: ResourceAdmissionScopeKey.make("workers-ai"),
        units: cost,
      },
    ]),
    grantId: ResourceAdmissionGrantId.make(`workers-ai-spend-${newId()}`),
    statements: [],
  },
});
