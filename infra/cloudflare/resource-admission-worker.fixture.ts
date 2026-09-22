import { Effect } from "effect";
import {
  ResourceAdmissionAuthority,
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
} from "./resource-admission";

type Environment = Readonly<{ DB: D1Database }>;

const fixedNowEpochMsValue = 10_000;
const rollingDurationMsValue = 1_000;
const burstLimitValue = 5;
const fixedNowEpochMs = ResourceAdmissionEpochMs.make(fixedNowEpochMsValue);

const policy = {
  dimension: "stable_user",
  durationMs: ResourceAdmissionDurationMs.make(rollingDurationMsValue),
  key: ResourceAdmissionPolicyKey.make("stable-user:multi-runtime:v1"),
  kind: "rolling_window",
  limit: ResourceAdmissionLimit.make(burstLimitValue),
} as const;

// Cloudflare module Workers require their fetch handler on a default export.
// eslint-disable-next-line import/no-default-export
export default {
  // This Miniflare fixture exposes the Promise-native Worker fetch boundary.
  // @effect-diagnostics-next-line asyncFunction:off
  async fetch(request: Request, environment: Environment): Promise<Response> {
    const authority = ResourceAdmissionAuthority.make({
      database: environment.DB,
      nowEpochMs: () => fixedNowEpochMs,
      policies: ResourceAdmissionPolicies.make([policy]),
    });
    const id = new URL(request.url).searchParams.get("id") ?? "";
    const result = await Effect.runPromise(
      Effect.result(
        authority.admit({
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
    );
    if (result._tag === "Success") return new Response(null, { status: 201 });
    if (result.failure instanceof ResourceAdmissionRefused) {
      return new Response(null, { status: 429 });
    }
    return new Response(null, { status: 503 });
  },
};
