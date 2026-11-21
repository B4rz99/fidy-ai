import { SqliteClient } from "@effect/sql-sqlite-do/SqliteClient";
import { Clock, Effect, Option, Schema } from "effect";
import {
  OAuthConnectionList,
  OAuthConnectionListQuery,
  OAuthConnectionRevoke,
  OAuthConnectionRevokeAll,
  oauthConnectionPageSize,
  oauthPaths,
} from "../../../src/shell/oauth-agents/contract";
import { type OAuthConnectionId } from "../../../src/core/oauth-agents/contract";
import { prepareOAuthActivityPage } from "../../../src/shell/audit/operations";
import { revokeOAuthUserConsent } from "../../../src/shell/consent/operations";
import { liveSessionConditions } from "../../../src/shell/web-session/operations";
import type { FreshSessionSubject } from "../../../src/shell/web-session/contract";
import { readBoundWebSessionProof } from "../../web-session/operations";
import { withStoreCapacity } from "../../runtime/sqlite/operations";
import { BootstrapUnavailable } from "../contract";
import { oauthSession } from "./native-browser";
import { ConnectionRow, projectConnection } from "./management";
import { decodePayload, invalidRequest } from "./bootstrap";
import { oauthResponse } from "./response";

import { admitUserOAuth } from "./native-admission";

const list = Effect.fn(function* (request: Request, session: FreshSessionSubject, current: number) {
  const sql = yield* SqliteClient;
  const query = new URL(request.url).searchParams;

  if (new Set(query.keys()).size !== Array.from(query.keys()).length) return invalidRequest();

  const decoded = Schema.decodeOption(OAuthConnectionListQuery, {
    onExcessProperty: "error",
  })(Object.fromEntries(query));

  if (Option.isNone(decoded)) return invalidRequest();
  const after = Option.getOrElse(decoded.value.after, () => "");
  const guard = liveSessionConditions({ session, current });

  const activity = prepareOAuthActivityPage({
    connections: {
      sql: "SELECT id,user_id FROM oauth_connections WHERE user_id=? AND id>? ORDER BY id LIMIT ?",
      params: [session.user_id, after, oauthConnectionPageSize],
    },
    guard,
  });

  const stored = yield* Schema.decodeUnknownEffect(Schema.Array(ConnectionRow))(
    yield* sql`SELECT id,claimed_client_name,scopes_json,expires_at_ms,revoked_at_ms FROM oauth_connections WHERE user_id=${session.user_id} AND id>${after} ORDER BY id LIMIT ${oauthConnectionPageSize + 1}`
  );

  const histories = yield* activity.decode(
    yield* sql.unsafe(activity.statement.sql, activity.statement.params)
  );

  const page = stored.slice(0, oauthConnectionPageSize);

  const connections = yield* Effect.forEach(page, (row) =>
    Effect.gen(function* () {
      const recentActivity = histories.get(row.id);

      if (recentActivity === undefined) {
        return yield* new BootstrapUnavailable({ cause: Option.none() });
      }

      return yield* projectConnection({ current, row, recentActivity });
    })
  );

  return oauthResponse({
    body: yield* Schema.encodeEffect(OAuthConnectionList)({
      connections,
      nextCursor:
        stored.length > page.length ? Option.fromUndefinedOr(page.at(-1)?.id) : Option.none(),
    }),
    status: 200,
  });
});

const maximumRevocations = 1024;

const revoke = Effect.fn(function* ({
  id,
  session,
  current,
}: {
  id: Option.Option<OAuthConnectionId>;
  session: FreshSessionSubject;
  current: number;
}) {
  const sql = yield* SqliteClient;

  if (
    Option.isSome(id) &&
    (yield* sql`SELECT 1 FROM oauth_connections WHERE user_id=${session.user_id} AND id=${id.value}`)
      .length !== 1
  ) {
    return invalidRequest();
  }

  const selected = {
    sql: `SELECT id AS connection_id,user_id FROM oauth_connections WHERE user_id=? AND revoked_at_ms IS NULL ${Option.isSome(id) ? "AND id=?" : ""} LIMIT ?`,
    params: [session.user_id, ...Option.toArray(id), maximumRevocations + 1],
  };

  const retained = yield* sql.unsafe(selected.sql, selected.params);

  if (retained.length > maximumRevocations) {
    return yield* new BootstrapUnavailable({ cause: Option.none() });
  }

  const statement = revokeOAuthUserConsent({
    session,
    current,
    reason: Option.isSome(id) ? "user_one" : "user_all",
    selection: selected,
  });

  const evidence = yield* sql.unsafe(statement.sql + " RETURNING connection_id", statement.params);

  const revoked = yield* sql.unsafe(
    "UPDATE oauth_connections SET revoked_at_ms=? WHERE id IN(SELECT connection_id FROM (" +
      selected.sql +
      ")) RETURNING id",
    [current, ...selected.params]
  );

  if (evidence.length !== retained.length || revoked.length !== retained.length) {
    return yield* new BootstrapUnavailable({ cause: Option.none() });
  }

  return oauthResponse({ body: { revoked: true }, status: 200 });
});

const revokeTarget = Effect.fn(function* (request: Request, path: string) {
  if (path === oauthPaths.connections) return Option.none<OAuthConnectionId>();

  if (path === oauthPaths.revoke) {
    return Option.some(
      (yield* decodePayload({ request, schema: OAuthConnectionRevoke, onExcessProperty: "error" }))
        .connectionId
    );
  }

  yield* decodePayload({ request, schema: OAuthConnectionRevokeAll, onExcessProperty: "error" });

  return Option.none<OAuthConnectionId>();
});

export const nativeManagement = Effect.fn(
  function* (input: {
    request: Request;
    owns: (id: string) => boolean;
    origin: string;
    retire: (connection: Option.Option<string>) => Effect.Effect<void>;
  }) {
    const { request, owns } = input;

    if (request.headers.get("origin") !== input.origin) {
      return oauthResponse({ body: { error: "forbidden_origin" }, status: 403 });
    }

    const path = new URL(request.url).pathname,
      listing = path === oauthPaths.connections;

    const proof = yield* Effect.tryPromise(() => readBoundWebSessionProof(request));
    const id = yield* revokeTarget(request, path);

    return yield* Effect.gen(function* () {
      const current = yield* Clock.currentTimeMillis;
      const live = yield* oauthSession({ proof, owns, fresh: false, requireConsent: false });

      if (Option.isNone(live)) {
        return oauthResponse({ body: { error: "unauthenticated" }, status: 401 });
      }

      if (!(yield* admitUserOAuth)) {
        return oauthResponse({ body: { error: "slow_down" }, status: 429 });
      }

      const session = live.value;

      if (listing) return yield* list(request, session, current);

      if (Option.isNone(yield* oauthSession({ proof, owns, fresh: true, requireConsent: false }))) {
        return oauthResponse({ body: { error: "reauthentication_required" }, status: 403 });
      }

      return yield* revoke({ id, session, current });
    }).pipe(
      withStoreCapacity("required"),
      Effect.tap((response) => (!listing && response.ok ? input.retire(id) : Effect.void))
    );
  },
  Effect.catchTag("BootstrapInvalid", () => Effect.succeed(invalidRequest())),
  Effect.catchCause(() =>
    Effect.succeed(oauthResponse({ body: { error: "temporarily_unavailable" }, status: 503 }))
  )
);
