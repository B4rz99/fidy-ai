import { BootstrapUnavailable, oauthTokenDestinationUrl } from "../contract";
import type { UserStoreBindings } from "../../directory/contract";
import { SqliteClient } from "@effect/sql-sqlite-do/SqliteClient";
import { Clock, Effect, Option, Redacted, Schema } from "effect";
import { isResponse } from "./bootstrap";
import { ConsentSubject } from "./consent-subject";
import { Base64Url, Hex } from "effect/encoding";
import { OAuthClientId } from "../../../src/core/oauth-agents/contract";
import { PATScopes } from "../../../src/core/tokens/contract";
import { OAuthRedirect, oauthResource } from "../../../src/shell/oauth-agents/contract";
import {
  protectConsentStatement,
  revokeOAuthReplayConsent,
} from "../../../src/shell/consent/operations";
import { digestBytes, newId, secretDigest } from "../../secret-material/operations";
import { withStoreAdmission, withStoreCapacity } from "../../runtime/sqlite/operations";
import { decodeExchange } from "./exchange";
import { invalidGrant, prepareIssuance } from "./refresh";
import { Destination, type Directory, register } from "./native-registration";
import { oauthResponse } from "./response";

import { admitUserOAuth } from "./native-admission";

const LocalProof = Schema.Struct({
  ...Destination.fields,
  client: OAuthClientId,
  resource: Schema.Literal(oauthResource),
  digest: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u)),
  deadline: Schema.Int,
  proof: Schema.Union([
    Schema.Struct({
      kind: Schema.Literal("code"),
      redirect: OAuthRedirect,
      challenge: Schema.String,
    }),
    Schema.Struct({
      kind: Schema.Literal("refresh"),
      scope: Schema.OptionFromNullOr(Schema.String),
    }),
  ]),
});

type LocalProof = typeof LocalProof.Type;

const deadlineMs = 5000;

export const forwardToken = Effect.fn(
  function* (request: Request, users: UserStoreBindings["USER_STORE"]) {
    if (
      request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !==
      "application/x-www-form-urlencoded"
    ) {
      return invalidGrant();
    }

    const now = yield* Clock.currentTimeMillis;
    const payload = yield* decodeExchange(request);
    const kind = payload.grant_type === "refresh_token" ? "refresh" : "code";

    const digest = Hex.encode(
      yield* secretDigest(
        payload.grant_type === "refresh_token"
          ? { purpose: "oauth-refresh", value: Redacted.make(payload.refresh_token) }
          : { purpose: "oauth-code", value: Redacted.make(payload.code) }
      )
    );

    const sql = yield* SqliteClient;

    const [row] =
      yield* sql`SELECT user_id,connection_id,record_id FROM oauth_routes WHERE kind=${kind} AND digest=${digest} AND expires_at_ms>${now}`;

    if (row === undefined) return invalidGrant();
    const route = yield* Schema.decodeUnknownEffect(Destination)(row);

    const proof =
      payload.grant_type === "refresh_token"
        ? { kind: "refresh" as const, scope: payload.scope }
        : {
            kind: "code" as const,
            redirect: payload.redirect_uri,
            challenge: Base64Url.encode(
              yield* digestBytes(new TextEncoder().encode(payload.code_verifier))
            ),
          };

    const body = yield* Schema.encodeEffect(Schema.fromJsonString(LocalProof))({
      ...route,
      client: payload.client_id,
      resource: payload.resource,
      digest,
      proof,
      deadline: now + deadlineMs,
    });

    return yield* Effect.tryPromise((signal) =>
      users
        .getByName(route.user_id)
        .fetch(oauthTokenDestinationUrl, { method: "POST", body, signal })
    );
  },
  Effect.catchTag("BootstrapInvalid", () => Effect.succeed(invalidGrant()))
);

const Observed = Schema.Struct({
  expires_at_ms: Schema.Int,
  scopes_json: Schema.String,
  grant_scopes_json: Schema.String,
  token_expiry: Schema.Int,
  consumed: Schema.NullOr(Schema.Int),
});

const revokeReplay = Effect.fn(function* (input: LocalProof, digest: Uint8Array, current: number) {
  const { user_id: user, connection_id: connection, record_id: record } = input,
    sql = yield* SqliteClient;

  const consent = revokeOAuthReplayConsent({
    id: newId(),
    userId: user,
    connectionId: connection,
    current,
    replay: {
      sql: "SELECT 1 FROM oauth_credentials WHERE kind='refresh' AND id=? AND connection_id=? AND user_id=? AND digest=? AND consumed_at_ms IS NOT NULL",
      params: [record, connection, user, digest],
    },
  });

  if ((yield* sql.unsafe(consent.sql + " RETURNING id", consent.params)).length !== 1) {
    return yield* new BootstrapUnavailable({ cause: Option.none() });
  }

  if (
    (yield* sql`UPDATE oauth_connections SET revoked_at_ms=${current} WHERE id=${connection} AND user_id=${user} AND revoked_at_ms IS NULL RETURNING id`)
      .length !== 1
  ) {
    return yield* new BootstrapUnavailable({ cause: Option.none() });
  }
});

const permitsScopes = (allowed: PATScopes, requested: PATScopes): boolean =>
  requested.every((scope) => allowed.includes(scope));

const selectScopes = Effect.fn(function* (proof: LocalProof["proof"], found: typeof Observed.Type) {
  const approved = yield* Schema.decodeEffect(Schema.fromJsonString(PATScopes))(found.scopes_json);

  const grantScopes = yield* Schema.decodeEffect(Schema.fromJsonString(PATScopes))(
    found.grant_scopes_json
  );

  const selected =
    proof.kind === "refresh" && Option.isSome(proof.scope)
      ? Schema.decodeUnknownOption(PATScopes)(proof.scope.value.split(" "))
      : Option.some(approved);

  if (
    Option.isNone(selected) ||
    !permitsScopes(approved, selected.value) ||
    !permitsScopes(grantScopes, selected.value)
  ) {
    return invalidGrant();
  }

  return {
    grant: {
      expires_at_ms: found.expires_at_ms,
      scopes_json: found.scopes_json,
      consumed_at_ms: Option.none<number>(),
    },
    scopes: selected.value,
  };
});

const observe = Effect.fn(function* (input: LocalProof, digest: Uint8Array, current: number) {
  const sql = yield* SqliteClient;

  const {
    user_id: user,
    connection_id: connection,
    record_id: record,
    client,
    resource,
    proof,
  } = input;

  const [row] =
    proof.kind === "code"
      ? yield* sql`SELECT expires_at_ms,scopes_json,scopes_json AS grant_scopes_json,code_expires_at_ms AS token_expiry,code_consumed_at_ms AS consumed FROM oauth_connections WHERE id=${connection} AND id=${record} AND user_id=${user} AND code_digest=${digest} AND client_id=${client} AND resource=${resource} AND redirect_uri=${proof.redirect} AND code_challenge=${proof.challenge} AND expires_at_ms>${current} AND revoked_at_ms IS NULL`
      : yield* sql`SELECT g.expires_at_ms,r.scopes_json,g.scopes_json AS grant_scopes_json,r.expires_at_ms AS token_expiry,r.consumed_at_ms AS consumed FROM oauth_connections g JOIN oauth_credentials r ON r.connection_id=g.id AND r.user_id=g.user_id WHERE g.id=${connection} AND g.user_id=${user} AND g.client_id=${client} AND g.resource=${resource} AND g.refresh_allowed=1 AND g.expires_at_ms>${current} AND g.revoked_at_ms IS NULL AND r.kind='refresh' AND r.id=${record} AND r.digest=${digest}`;

  if (row === undefined) return invalidGrant();
  const found = yield* Schema.decodeUnknownEffect(Observed)(row);

  if (found.consumed !== null) {
    if (proof.kind === "refresh") {
      yield* revokeReplay(input, digest, current);

      return "family-revoked" as const;
    }

    return invalidGrant();
  }

  if (found.token_expiry <= current) return invalidGrant();

  const allowed = protectConsentStatement({
    subject: ConsentSubject.User({ userId: user }),
    requirement: "active",
    statement: {
      sql: "SELECT 1 WHERE EXISTS(SELECT 1 FROM consent_history WHERE record_type='oauth_grant' AND connection_id=? AND user_id=?)",
      params: [connection, user],
    },
  });

  if ((yield* sql.unsafe(allowed.sql, allowed.params)).length !== 1) return invalidGrant();

  return yield* selectScopes(proof, found);
});

const commitTokens = Effect.fn(function* ({
  input,
  digest,
  current,
  issuance,
  accessId,
}: {
  input: LocalProof;
  digest: Uint8Array;
  current: number;
  issuance: Effect.Success<ReturnType<typeof prepareIssuance>>;
  accessId: string;
}) {
  const sql = yield* SqliteClient;

  const user = input.user_id,
    connection = input.connection_id;

  yield* Effect.forEach(
    [
      {
        kind: "access",
        id: accessId,
        digest: issuance.accessDigest,
        expires: issuance.accessExpiresAt,
      },
      {
        kind: "refresh",
        id: issuance.refreshId,
        digest: issuance.refreshDigest,
        expires: issuance.refreshExpiresAt,
      },
    ],
    Effect.fnUntraced(function* (token) {
      const inserted =
        yield* sql`INSERT INTO oauth_credentials(kind,id,user_id,connection_id,digest,issued_at_ms,expires_at_ms,scopes_json) VALUES(${token.kind},${token.id},${user},${connection},${token.digest},${current},${token.expires},${issuance.scopesJson}) RETURNING id`;

      if (inserted.length !== 1) return yield* new BootstrapUnavailable({ cause: Option.none() });
    }),
    { discard: true }
  );

  const used =
    input.proof.kind === "code"
      ? yield* sql`UPDATE oauth_connections SET code_consumed_at_ms=${current} WHERE id=${connection} AND user_id=${user} AND code_digest=${digest} AND code_consumed_at_ms IS NULL RETURNING id`
      : yield* sql`UPDATE oauth_credentials SET consumed_at_ms=${current},replacement_refresh_id=${issuance.refreshId} WHERE kind='refresh' AND id=${input.record_id} AND connection_id=${connection} AND user_id=${user} AND digest=${digest} AND consumed_at_ms IS NULL RETURNING id`;

  if (used.length !== 1) return yield* new BootstrapUnavailable({ cause: Option.none() });

  return oauthResponse({ body: issuance.body, status: 200 });
});

const admitExchange = Effect.fn(function* (input: LocalProof, digest: Uint8Array, current: number) {
  const checked = yield* observe(input, digest, current);

  if (
    input.proof.kind === "refresh" &&
    checked !== "family-revoked" &&
    !isResponse(checked) &&
    !(yield* admitUserOAuth)
  ) {
    return oauthResponse({ body: { error: "slow_down" }, status: 429 });
  }

  return checked;
});

type TokenOwner = {
  directory: Directory;
  owns: (id: string) => boolean;
  retire: (connection: Option.Option<string>) => Effect.Effect<void>;
};

export const exchangeLocalToken = Effect.fn(
  function* (request: Request, { directory, owns, retire }: TokenOwner) {
    const input = yield* Schema.decodeUnknownEffect(LocalProof)(
      yield* Effect.tryPromise(() => request.json())
    );

    const digest = yield* Effect.fromResult(Hex.decode(input.digest));

    if (
      !owns(input.user_id) ||
      input.deadline <= (yield* Clock.currentTimeMillis) ||
      request.signal.aborted
    ) {
      return invalidGrant();
    }

    const initial = yield* Clock.currentTimeMillis;
    const found = yield* admitExchange(input, digest, initial).pipe(withStoreCapacity("required"));
    const retired = retire(Option.some(input.connection_id)).pipe(Effect.as(invalidGrant()));

    if (found === "family-revoked") return yield* retired;

    if (isResponse(found)) return found;
    const issuance = yield* prepareIssuance({ current: initial, ...found });
    const accessId = newId();

    const reserve = yield* register(
      directory,
      {
        action: "reserve",
        user: input.user_id,
        connection: input.connection_id,
        operation: input.record_id,
        routes: [
          {
            kind: "access",
            digest: Hex.encode(issuance.accessDigest),
            record: accessId,
            expires: issuance.accessExpiresAt,
          },
          {
            kind: "refresh",
            digest: Hex.encode(issuance.refreshDigest),
            record: issuance.refreshId,
            expires: found.grant.expires_at_ms,
          },
        ],
      },
      Schema.Boolean
    );

    if (Option.isNone(reserve)) return yield* new BootstrapUnavailable({ cause: Option.none() });

    const result = yield* withStoreAdmission((admitGrowth) =>
      Effect.gen(function* () {
        const current = yield* Clock.currentTimeMillis;

        if (input.deadline <= current || request.signal.aborted) return invalidGrant();
        const live = yield* observe(input, digest, current);

        if (live === "family-revoked" || isResponse(live)) return live;

        if (!permitsScopes(live.scopes, found.scopes)) return invalidGrant();
        yield* admitGrowth;

        return yield* commitTokens({ input, digest, current, issuance, accessId });
      })
    );

    return result === "family-revoked" ? yield* retired : result;
  },
  Effect.catchCause(() =>
    Effect.succeed(oauthResponse({ body: { error: "temporarily_unavailable" }, status: 503 }))
  )
);
