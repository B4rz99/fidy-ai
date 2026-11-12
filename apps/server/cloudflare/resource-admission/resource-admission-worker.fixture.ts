import { admitResource, releaseOutstandingResource } from "./operations";
import { Effect } from "effect";
import {
  type ResourceAdmissionAuthorityConfig,
  type ResourceAdmissionCharge,
  ResourceAdmissionCharges,
  ResourceAdmissionDurationMs,
  ResourceAdmissionEpochMs,
  ResourceAdmissionGrantId,
  ResourceAdmissionLimit,
  ResourceAdmissionPolicies,
  ResourceAdmissionPolicyKey,
  ResourceAdmissionRefused,
  ResourceAdmissionScopeKey,
  ResourceAdmissionUnits,
} from "./contract";

type Environment = Readonly<{ DB: D1Database }>;

const fixedNowEpochMsValue = 10_000;
const rollingDurationMsValue = 1_000;
const burstLimitValue = 5;
const occupancyLeaseMsValue = 1_000;
const spendDurationMsValue = 10_000;
const fixedNowEpochMs = ResourceAdmissionEpochMs.make(fixedNowEpochMsValue);

const policy = {
  dimension: "stable_user",
  durationMs: ResourceAdmissionDurationMs.make(rollingDurationMsValue),
  key: ResourceAdmissionPolicyKey.make("stable-user:multi-runtime:v1"),
  kind: "rolling_window",
  limit: ResourceAdmissionLimit.make(burstLimitValue),
} as const;

const occupancyPolicy = {
  dimension: "outstanding_work",
  key: ResourceAdmissionPolicyKey.make("work:multi-runtime:v1"),
  kind: "outstanding",
  leaseMs: ResourceAdmissionDurationMs.make(occupancyLeaseMsValue),
  limit: ResourceAdmissionLimit.make(1),
} as const;
const spendPolicy = {
  dimension: "spend",
  durationMs: ResourceAdmissionDurationMs.make(spendDurationMsValue),
  key: ResourceAdmissionPolicyKey.make("spend:multi-runtime:v1"),
  kind: "rolling_window",
  limit: ResourceAdmissionLimit.make(1),
} as const;

const settleClaim = (url: URL, environment: Environment): Promise<Response> => {
  const authority: ResourceAdmissionAuthorityConfig = {
    database: environment.DB,
    nowEpochMs: () => ResourceAdmissionEpochMs.make(Number(url.searchParams.get("now"))),
    policies: ResourceAdmissionPolicies.make([occupancyPolicy, spendPolicy]),
  };
  const grantId = ResourceAdmissionGrantId.make(url.searchParams.get("id") ?? "");
  const action = url.searchParams.get("action");
  const charge = (key: ResourceAdmissionPolicyKey): ResourceAdmissionCharge => ({
    policyKey: key,
    scopeKey: ResourceAdmissionScopeKey.make("user:lifecycle"),
    units: ResourceAdmissionUnits.make(1),
  });
  const charges = ResourceAdmissionCharges.make(
    action === "composite"
      ? [charge(occupancyPolicy.key), charge(spendPolicy.key)]
      : [charge(action === "spend" ? spendPolicy.key : occupancyPolicy.key)]
  );
  const work =
    action === "release"
      ? releaseOutstandingResource(authority, { grantId, statements: [] })
      : admitResource(authority, { charges, grantId, statements: [] }).pipe(Effect.asVoid);
  return Effect.runPromise(Effect.result(work)).then((result) => {
    if (result._tag === "Success") return new Response(null, { status: 201 });
    if (result.failure instanceof ResourceAdmissionRefused) {
      return new Response(null, { status: 429 });
    }
    return new Response(null, { status: 503 });
  });
};

export default {
  fetch(request: Request, environment: Environment): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/lifecycle") return settleClaim(url, environment);
    const authority = {
      database: environment.DB,
      nowEpochMs: (): ResourceAdmissionEpochMs => fixedNowEpochMs,
      policies: ResourceAdmissionPolicies.make([policy]),
    };
    const id = new URL(request.url).searchParams.get("id") ?? "";
    return Effect.runPromise(
      Effect.result(
        admitResource(authority, {
          charges: ResourceAdmissionCharges.make([
            {
              policyKey: policy.key,
              scopeKey: ResourceAdmissionScopeKey.make("user:f1d1a000"),
              units: ResourceAdmissionUnits.make(1),
            },
          ]),
          grantId: ResourceAdmissionGrantId.make(id),
          statements: [],
        })
      )
    ).then((result) => {
      if (result._tag === "Success") return new Response(null, { status: 201 });
      if (result.failure instanceof ResourceAdmissionRefused) {
        return new Response(null, { status: 429 });
      }
      return new Response(null, { status: 503 });
    });
  },
};
