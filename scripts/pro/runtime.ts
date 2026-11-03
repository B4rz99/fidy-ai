import { OutboundHttpLive } from "../../apps/server/cloudflare/outbound-http/runtime";
import { Context, Effect, Layer, type Redacted, Schema } from "effect";
import { HttpClient } from "effect/http";
import {
  ProGrantFailure,
  type ProGrantQuery,
} from "../../apps/server/src/shell/pro-grants/contract";
import { makeOperatorD1Http } from "../../apps/server/src/shell/outbound-http/operations";

const Reply = Schema.fromJsonString(
  Schema.Struct({
    success: Schema.Literal(true),
    result: Schema.Tuple([
      Schema.Struct({ success: Schema.Literal(true), results: Schema.Array(Schema.Unknown) }),
    ]),
  })
);
const unavailable = (): ProGrantFailure =>
  new ProGrantFailure({ reason: "unavailable", candidates: [] });
const httpOk = 200;

/** The caller's scope owns one fixed database's native HTTP authority and response readers. */
export const makeProQuery = Effect.fn(function* (
  config: Readonly<{
    accountId: string;
    databaseId: string;
    token: Redacted.Redacted<string>;
  }>
) {
  const services = yield* Layer.build(OutboundHttpLive);
  const http = makeOperatorD1Http({
    ...config,
    client: Context.get(services, HttpClient.HttpClient),
  });
  const query: ProGrantQuery = (statement) =>
    Effect.gen(function* () {
      const params = yield* Schema.decodeUnknownEffect(
        Schema.Array(Schema.Union([Schema.String, Schema.Finite]))
      )(statement.params);
      const body = yield* Schema.encodeEffect(
        Schema.fromJsonString(
          Schema.Struct({
            sql: Schema.String,
            params: Schema.Array(Schema.Union([Schema.String, Schema.Finite])),
          })
        )
      )({ sql: statement.sql, params });
      const response = yield* http.execute(body);
      if (response.status !== httpOk) return yield* unavailable();
      const reply = yield* Schema.decodeEffect(Reply)(new TextDecoder().decode(response.body));
      return reply.result.flatMap((entry) => entry.results);
    }).pipe(Effect.mapError(unavailable));
  return query;
});
