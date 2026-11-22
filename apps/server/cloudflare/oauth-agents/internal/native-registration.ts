import { BootstrapUnavailable, oauthRouteCommandUrl } from "../contract";
import { SqliteClient } from "@effect/sql-sqlite-do/SqliteClient";
import { Clock, Effect, Option, Schema } from "effect";
import { UserId } from "../../../src/core/identity/contract";
import { OAuthConnectionId, OAuthCredentialId } from "../../../src/core/oauth-agents/contract";
import {
  OAuthAuthorization,
  OAuthRegistration,
  OAuthRequestId,
} from "../../../src/shell/oauth-agents/contract";
import {
  currentRouteReservation,
  directoryName,
  routeIssuedHeader,
} from "../../directory/contract";
import { withStoreCapacity } from "../../runtime/sqlite/operations";

export type Directory = Pick<DurableObjectNamespace, "getByName">;

const Route = Schema.Struct({
  kind: Schema.Literals(["code", "access", "refresh"]),
  digest: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u)),
  record: Schema.String.check(Schema.isUUID()),
  expires: Schema.Int,
});

const Finish = Schema.Struct({
  action: Schema.Literal("finish"),
  user: UserId,
  requestId: OAuthRequestId,
});

const Bind = Schema.Struct({
  action: Schema.Literal("bind"),
  user: UserId,
  requestId: OAuthRequestId,
});

const Reserve = Schema.Struct({
  action: Schema.Literal("reserve"),
  user: UserId,
  connection: OAuthConnectionId,
  operation: Schema.String,
  routes: Schema.NonEmptyArray(Route).check(Schema.isMaxLength(2)),
});

export const FrozenReview = Schema.Struct({
  request_json: Schema.fromJsonString(OAuthAuthorization),
  metadata_json: Schema.fromJsonString(OAuthRegistration),
  expires_at_ms: Schema.Int,
});

export const Destination = Schema.Struct({
  user_id: UserId,
  connection_id: OAuthConnectionId,
  record_id: OAuthCredentialId,
});

const absentRecord = 404;

export const register = Effect.fn(function* <A, Encoded>(
  directory: Directory,
  input: typeof Bind.Type | typeof Reserve.Type | typeof Finish.Type,
  codec: Schema.Codec<A, Encoded>
) {
  const issuedAt = yield* Clock.currentTimeMillis;
  const body = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(input);

  const result = yield* Effect.tryPromise((signal) =>
    directory.getByName(directoryName).fetch(oauthRouteCommandUrl, {
      method: "POST",
      headers: { [routeIssuedHeader]: String(issuedAt) },
      body,
      signal,
    })
  );

  if (result.status === absentRecord) return Option.none<A>();

  if (!result.ok) return yield* new BootstrapUnavailable({ cause: Option.none() });

  return Option.some(
    yield* Schema.decodeUnknownEffect(codec)(yield* Effect.tryPromise(() => result.json()))
  );
});

export const oauthCredentialCommand = Effect.fn(function* (request: Request) {
  const input = yield* Schema.decodeUnknownEffect(Schema.Union([Bind, Reserve, Finish]))(
    yield* Effect.tryPromise(() => request.json())
  );

  const sql = yield* SqliteClient;

  return yield* Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis;

    if (input.action === "finish") {
      yield* sql`UPDATE oauth_review_requests SET completed=1 WHERE id=${input.requestId} AND user_id=${input.user}`;

      return Response.json(true);
    }

    if (input.action === "bind") {
      yield* sql`UPDATE oauth_review_requests SET user_id=${input.user} WHERE id=${input.requestId} AND user_id IS NULL AND expires_at_ms>${now} AND (SELECT count(*) FROM oauth_review_requests WHERE user_id=${input.user} AND expires_at_ms>${now} AND completed=0)<5`;

      const [row] =
        yield* sql`SELECT r.request_json,c.metadata_json,r.expires_at_ms FROM oauth_review_requests r JOIN oauth_public_clients c ON c.id=r.client_id WHERE r.id=${input.requestId} AND r.user_id=${input.user} AND NOT EXISTS(SELECT 1 FROM erasure_barriers WHERE user_id=r.user_id) AND r.expires_at_ms>${now}`;

      return row === undefined ? new Response(null, { status: 404 }) : Response.json(row);
    }

    if (!currentRouteReservation({ request, now })) {
      return yield* new BootstrapUnavailable({ cause: Option.none() });
    }

    yield* Effect.forEach(
      input.routes,
      Effect.fnUntraced(function* (route) {
        if (route.expires <= now) return yield* new BootstrapUnavailable({ cause: Option.none() });
        yield* sql`INSERT INTO oauth_routes(kind,digest,user_id,connection_id,record_id,operation,expires_at_ms) VALUES(${route.kind},${route.digest},${input.user},${input.connection},${route.record},${input.operation},${route.expires}) ON CONFLICT DO NOTHING`;

        const exact =
          yield* sql`SELECT 1 FROM oauth_routes WHERE kind=${route.kind} AND digest=${route.digest} AND user_id=${input.user} AND connection_id=${input.connection} AND record_id=${route.record} AND operation=${input.operation} AND expires_at_ms=${route.expires}`;

        if (exact.length !== 1) return yield* new BootstrapUnavailable({ cause: Option.none() });
      }),
      { discard: true }
    );

    return Response.json(true);
  }).pipe(withStoreCapacity("growth"));
});
