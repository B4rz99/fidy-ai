import { Array, Clock, Effect, Option, Redacted, Schema } from "effect";
import { Hex } from "effect/encoding";
import {
  microsoftProviderPaths,
  providerPaths,
} from "../../../src/shell/provider-authentication/contract";
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
import { newId, secretDigest } from "../../secret-material/operations";

const limitedStatus = 429;
const unavailableStatus = 503;
const minuteMs = 60_000;
const pollWindowMs = 5_000;
const policies = Schema.decodeUnknownSync(ResourceAdmissionPolicies)(
  [
    { name: "source", limit: 120, duration: minuteMs },
    { name: "global", limit: 1200, duration: minuteMs },
    { name: "exchange-source", limit: 30, duration: minuteMs },
    { name: "exchange-global", limit: 300, duration: minuteMs },
    { name: "poll", limit: 5, duration: pollWindowMs },
  ].map(({ name, limit, duration }) => ({
    key: ResourceAdmissionPolicyKey.make(`provider.${name}.v1`),
    dimension: "operation",
    kind: "rolling_window",
    durationMs: ResourceAdmissionDurationMs.make(duration),
    limit: ResourceAdmissionLimit.make(limit),
  }))
);
const Source = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u));
const refused = (status: number): Response =>
  Response.json(
    { status: status === limitedStatus ? "limited" : "unavailable" },
    {
      status,
      headers: {
        "cache-control": "no-store",
        "referrer-policy": "no-referrer",
        "retry-after": "60",
      },
    }
  );
const claim = (
  db: D1Database,
  scopes: Array.NonEmptyReadonlyArray<Readonly<{ name: string; scope: string }>>
): Effect.Effect<Option.Option<Response>> =>
  Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis;
    yield* admitResource(
      {
        database: db,
        policies,
        nowEpochMs: () => ResourceAdmissionEpochMs.make(now),
      },
      {
        grantId: ResourceAdmissionGrantId.make(`provider-admission-${newId()}`),
        charges: ResourceAdmissionCharges.make(
          Array.map(scopes, ({ name, scope }) => ({
            policyKey: ResourceAdmissionPolicyKey.make(`provider.${name}.v1`),
            scopeKey: ResourceAdmissionScopeKey.make(scope),
            units: ResourceAdmissionUnits.make(1),
          }))
        ),
        statements: [],
      }
    );
    return Option.none<Response>();
  }).pipe(
    Effect.catchTags({
      ResourceAdmissionRefused: () => Effect.succeedSome(refused(limitedStatus)),
      ResourceAdmissionUnavailable: () => Effect.succeedSome(refused(unavailableStatus)),
    })
  );

export const admitProviderRequest = ({
  request,
  db,
}: Readonly<{ request: Request; db: D1Database }>): Effect.Effect<Option.Option<Response>> => {
  const source = Schema.decodeUnknownOption(Source)(request.headers.get("x-provider-source"));
  if (Option.isNone(source)) return Effect.succeedSome(refused(unavailableStatus));
  const path = new URL(request.url).pathname;
  const cheap =
    path === providerPaths.disclosure ||
    path === providerPaths.status ||
    path === microsoftProviderPaths.status;
  return claim(db, [
    { name: "source", scope: source.value },
    { name: "global", scope: "all" },
    ...(cheap
      ? []
      : [
          { name: "exchange-source", scope: source.value },
          { name: "exchange-global", scope: "all" },
        ]),
  ]);
};

export const admitProviderPoll = ({
  db,
  privateVerifier,
}: Readonly<{ db: D1Database; privateVerifier: string }>): Effect.Effect<Option.Option<Response>> =>
  secretDigest({ purpose: "provider-poll", value: Redacted.make(privateVerifier) }).pipe(
    Effect.flatMap((digest) => claim(db, [{ name: "poll", scope: Hex.encode(digest) }])),
    Effect.orElseSucceed(() => Option.some(refused(unavailableStatus)))
  );
