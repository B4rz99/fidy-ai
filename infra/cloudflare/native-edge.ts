import { isDeepStrictEqual } from "node:util";
import { Effect, Schema, Struct } from "effect";
import { HttpBody, HttpClient, HttpClientRequest } from "effect/http";
import { edgeSecurityPolicy } from "./edge-security";
import { type ProductionReleaseConfig, releaseEvidence } from "./production-release";

const id = Schema.String.check(Schema.isPattern(/^[a-f0-9]{32}$/u));

const Zone = Schema.Struct({
  id,
  name: Schema.Literal("fidyapp.com"),
  status: Schema.Literal("active"),
  account: Schema.Struct({ id }),
});

const WireRule = Schema.Struct({
  id,
  ref: Schema.String,
  action: Schema.String,
  description: Schema.String,
  expression: Schema.String,
  enabled: Schema.Boolean,
  action_parameters: Schema.optional(
    Schema.Struct({
      phases: Schema.optional(Schema.Array(Schema.String)),
      products: Schema.optional(Schema.Array(Schema.String)),
    })
  ),
  logging: Schema.optionalKey(Schema.Struct({ enabled: Schema.Literal(true) })),
  last_updated: Schema.optional(Schema.String),
  version: Schema.optional(Schema.String),
}).check(Schema.makeFilter((rule) => rule.logging === undefined || rule.action === "skip"));

const Ruleset = Schema.Struct({
  id,
  kind: Schema.Literal("zone"),
  phase: Schema.Literal("http_request_firewall_custom"),
  rules: Schema.Array(Schema.Unknown),
});

const previousExpressions = [
  '(http.host eq "api.fidyapp.com")',
  'not http.host in {"docs.fidyapp.com" "fidyapp.com" "app.fidyapp.com" "api.fidyapp.com"}',
  '(http.host eq "api.fidyapp.com" and not (http.request.method in {"GET" "POST" "OPTIONS" "DELETE" "PUT" "PATCH"}))',
];

const expected = edgeSecurityPolicy.rulesets.customFirewall.rules;

type Change = {
  path: string;
  body: Pick<
    typeof WireRule.Type,
    "ref" | "action" | "description" | "enabled" | "expression" | "logging"
  > & {
    action_parameters: typeof WireRule.Type.action_parameters;
  };
};

export const nativeEdgeChanges = (value: unknown): ReadonlyArray<Change> => {
  const ruleset = Schema.decodeUnknownSync(Ruleset)(value);

  const rules = Schema.decodeUnknownSync(Schema.Array(WireRule), { onExcessProperty: "error" })(
    ruleset.rules
  );

  if (
    rules.length !== expected.length ||
    new Set(rules.map((rule) => rule.id)).size !== expected.length
  ) {
    throw Error("Unexpected custom firewall order or rule count");
  }

  return rules.flatMap((rule, index) => {
    const target = expected[index];

    if (
      target === undefined ||
      target.action !== rule.action ||
      target.description !== rule.description ||
      !rule.enabled ||
      !isDeepStrictEqual(rule.action_parameters, target.actionParameters)
    ) {
      throw Error("Unexpected custom firewall definition");
    }

    if (rule.expression === target.expression) return [];

    if (rule.expression !== previousExpressions[index]) {
      throw Error("Unreviewed custom firewall expression");
    }

    return [
      {
        path: `rulesets/${ruleset.id}/rules/${rule.id}`,
        body: {
          ref: rule.ref,
          action: rule.action,
          description: rule.description,
          enabled: rule.enabled,
          expression: target.expression,
          action_parameters: rule.action_parameters,
          ...Struct.pick(rule, ["logging"]),
        },
      },
    ];
  });
};

export const verifyNativeEdge = Effect.fn(function* (
  env: Pick<ProductionReleaseConfig, "account" | "token">,
  client: HttpClient.HttpClient,
  mode: "plan" | "install" | "verify"
) {
  const base = "https://api.cloudflare.com/client/v4";
  const headers = { authorization: "Bearer " + env.token };

  const read = Effect.fn(function* (url: string) {
    const value = yield* releaseEvidence
      .providerJson(HttpClientRequest.get(url, { headers }))
      .pipe(Effect.provideService(HttpClient.HttpClient, client));

    return (yield* Schema.decodeUnknownEffect(
      Schema.Struct({ success: Schema.Literal(true), result: Schema.Unknown })
    )(value)).result;
  });

  const [zone] = yield* Schema.decodeUnknownEffect(Schema.Tuple([Zone]))(
    yield* read(base + "/zones?name=fidyapp.com&account.id=" + env.account)
  );

  if (zone.account.id !== env.account) {
    return yield* Effect.fail(Error("Unknown zone authority"));
  }

  const zoneUrl = base + "/zones/" + zone.id + "/";

  const inspect = Effect.fn(function* () {
    const ruleset = yield* read(
      zoneUrl + "rulesets/phases/http_request_firewall_custom/entrypoint"
    );

    return yield* Effect.try(() => nativeEdgeChanges(ruleset));
  });

  const patch = Effect.fnUntraced(function* (change: Change) {
    return yield* releaseEvidence
      .providerJson(
        HttpClientRequest.patch(zoneUrl + change.path, {
          headers,
          body: HttpBody.text(releaseEvidence.encodeJson(change.body), "application/json"),
        })
      )
      .pipe(Effect.provideService(HttpClient.HttpClient, client));
  });

  const converge = (
    mutations: number
  ): Effect.Effect<void, Effect.Error<ReturnType<typeof inspect>> | Error> =>
    Effect.gen(function* () {
      const changes = yield* inspect();
      const change = changes[0];

      if (change === undefined || mode === "plan") return;

      if (mode !== "install" || mutations === previousExpressions.length) {
        return yield* Effect.fail(Error("Acceptance hostname policy is incomplete"));
      }

      yield* patch(change);

      return yield* converge(mutations + 1);
    });

  yield* converge(0);
});
