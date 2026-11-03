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
} from "../../resource-admission/contract";

export const openAiAdmissionWindowMs = 86_400_000;
const oneDay = ResourceAdmissionDurationMs.make(openAiAdmissionWindowMs);
const maximumUserAttempts = 500;
const maximumGlobalAttempts = 50_000;
const maximumUserSpend = 32_000_000;
const maximumGlobalSpend = 512_000_000;
const oneUnit = ResourceAdmissionUnits.make(1);
export const openAiPolicies = ResourceAdmissionPolicies.make([
  {
    dimension: "stable_user",
    durationMs: oneDay,
    key: ResourceAdmissionPolicyKey.make("openai.attempt.user.v1"),
    kind: "rolling_window",
    limit: ResourceAdmissionLimit.make(maximumUserAttempts),
  },
  {
    dimension: "operation",
    durationMs: oneDay,
    key: ResourceAdmissionPolicyKey.make("openai.attempt.global.v1"),
    kind: "rolling_window",
    limit: ResourceAdmissionLimit.make(maximumGlobalAttempts),
  },
  {
    dimension: "spend",
    durationMs: oneDay,
    key: ResourceAdmissionPolicyKey.make("openai.spend.user.v1"),
    kind: "rolling_window",
    limit: ResourceAdmissionLimit.make(maximumUserSpend),
  },
  {
    dimension: "spend",
    durationMs: oneDay,
    key: ResourceAdmissionPolicyKey.make("openai.spend.global.v1"),
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
        policyKey: ResourceAdmissionPolicyKey.make("openai.attempt.user.v1"),
        scopeKey: ResourceAdmissionScopeKey.make(userId),
        units: oneUnit,
      },
      {
        policyKey: ResourceAdmissionPolicyKey.make("openai.attempt.global.v1"),
        scopeKey: ResourceAdmissionScopeKey.make("openai"),
        units: oneUnit,
      },
    ]),
    grantId: ResourceAdmissionGrantId.make(`openai-attempt-${newId()}`),
    statements: [],
  },
  work: {
    charges: ResourceAdmissionCharges.make([
      {
        policyKey: ResourceAdmissionPolicyKey.make("openai.spend.user.v1"),
        scopeKey: ResourceAdmissionScopeKey.make(userId),
        units: cost,
      },
      {
        policyKey: ResourceAdmissionPolicyKey.make("openai.spend.global.v1"),
        scopeKey: ResourceAdmissionScopeKey.make("openai"),
        units: cost,
      },
    ]),
    grantId: ResourceAdmissionGrantId.make(`openai-spend-${newId()}`),
    statements: [],
  },
});
