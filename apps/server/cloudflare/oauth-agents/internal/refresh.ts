import { Clock, Effect, Option, type PlatformError, Redacted, Schema } from "effect";
import { OAuthRefreshAdmission } from "../contract";
import { PATScopes } from "../../../src/core/tokens/contract";
import { decideOAuthCredentialExpirations } from "../../../src/core/oauth-agents/operations";
import type { OAuthCredentialExpirations } from "../../../src/core/oauth-agents/contract";
import {
  protectConsentStatement,
  protectOAuthGrantConsentAuthority,
  revokeOAuthReplayConsent,
} from "../../../src/shell/consent/operations";
import { newId, newSecret, secretDigest } from "../../secret-material/operations";
import { BootstrapUnavailable, dbWork } from "./bootstrap";
import { oauthResponse } from "./response";

const secondMs = 1000;
export const invalidGrant = (): Response =>
  oauthResponse({ body: { error: "invalid_grant" }, status: 400 });
const GrantRow = Schema.Struct({
  expires_at_ms: Schema.Int,
  scopes_json: Schema.String,
  consumed_at_ms: Schema.OptionFromNullOr(Schema.Int),
});
type GrantRow = typeof GrantRow.Type;
const TokenResponse = Schema.Struct({
  access_token: Schema.String,
  refresh_token: Schema.String,
  token_type: Schema.Literal("Bearer"),
  expires_in: Schema.Int,
  scope: Schema.String,
});
type RefreshInput = Readonly<{
  db: D1Database;
  admission: OAuthRefreshAdmission;
  signal: AbortSignal;
}>;
type Issuance = OAuthCredentialExpirations &
  Readonly<{
    accessDigest: Uint8Array;
    refreshDigest: Uint8Array;
    refreshId: string;
    scopesJson: string;
    body: typeof TokenResponse.Type;
  }>;

const coordinatorHeaders = { "content-type": "application/json" };
const RefreshHint = Schema.Struct({
  credentialId: Schema.String,
  connectionId: Schema.String,
  userId: Schema.String,
});
type ForwardInput = Readonly<{
  db: D1Database;
  deadlineAtMs: number;
  payload: Readonly<{
    refresh_token: string;
    client_id: string;
    resource: string;
    scope: Option.Option<string>;
  }>;
  coordinator: Readonly<{ getByName: (name: string) => Pick<Fetcher, "fetch"> }>;
  admitUser: (userId: string) => Effect.Effect<void, BootstrapUnavailable>;
}>;
/** Resolves only a coordination hint; no raw credential leaves the token boundary. */
export const forwardRefresh = (
  input: ForwardInput
): Effect.Effect<
  Response,
  BootstrapUnavailable | Schema.SchemaError | PlatformError.PlatformError
> =>
  Effect.gen(function* () {
    const digest = yield* secretDigest({
      purpose: "oauth-refresh",
      value: Redacted.make(input.payload.refresh_token),
    });
    const found = yield* Effect.tryPromise({
      try: () =>
        input.db
          .prepare(`SELECT r.id AS credentialId,r.connection_id AS connectionId,r.user_id AS userId
    FROM oauth_refresh_credentials r JOIN oauth_connections g ON g.id = r.connection_id
    WHERE r.digest = ? AND r.user_id = g.user_id AND g.client_id = ? AND g.resource = ?`)
          .bind(digest, input.payload.client_id, input.payload.resource)
          .first(),
      catch: () => new BootstrapUnavailable(),
    });
    const hint = yield* Schema.decodeUnknownEffect(RefreshHint)(found);
    const admission = yield* Schema.decodeUnknownEffect(OAuthRefreshAdmission)({
      ...hint,
      deadlineAtMs: input.deadlineAtMs,
      digest: Array.from(digest),
      clientId: input.payload.client_id,
      resource: input.payload.resource,
      ...Option.match(input.payload.scope, {
        onNone: () => ({}),
        onSome: (scope) => ({ scope }),
      }),
    });
    yield* input.admitUser(admission.userId);
    const body = yield* Schema.encodeEffect(Schema.fromJsonString(OAuthRefreshAdmission))(
      admission
    );
    return yield* Effect.tryPromise({
      try: (signal) =>
        input.coordinator.getByName(admission.userId).fetch(
          new Request("https://coordinator.internal/oauth-refresh", {
            method: "POST",
            headers: coordinatorHeaders,
            body,
            signal,
          })
        ),
      catch: () => new BootstrapUnavailable(),
    });
  });

const boundCredential = (
  admission: OAuthRefreshAdmission
): Readonly<{ sql: string; params: ReadonlyArray<string | number | Uint8Array> }> => {
  const authority = protectOAuthGrantConsentAuthority({
    subject: { userId: admission.userId, connectionId: admission.connectionId },
    authority: {
      table: "oauth_refresh_credentials",
      predicate: `id = ? AND connection_id = ? AND user_id = ? AND digest = ?
    AND EXISTS (SELECT 1 FROM oauth_connections g WHERE g.id = oauth_refresh_credentials.connection_id
      AND g.user_id = oauth_refresh_credentials.user_id AND g.client_id = ? AND g.resource = ? AND g.refresh_allowed = 1)`,
      bindings: [
        admission.credentialId,
        admission.connectionId,
        admission.userId,
        new Uint8Array(admission.digest),
        admission.clientId,
        admission.resource,
      ],
    },
  });
  return { sql: authority.predicate, params: authority.bindings };
};
const assertion = (db: D1Database): D1PreparedStatement =>
  db.prepare(
    "INSERT INTO oauth_atomic_assertion VALUES (1,CASE WHEN changes() = 1 THEN 1 ELSE 0 END) ON CONFLICT(id) DO UPDATE SET accepted = excluded.accepted"
  );
export const revokeReplay = ({
  input,
  current,
}: Readonly<{ input: RefreshInput; current: number }>): Effect.Effect<void, BootstrapUnavailable> =>
  Effect.gen(function* () {
    const bound = boundCredential(input.admission);
    const evidence = revokeOAuthReplayConsent({
      id: newId(),
      userId: input.admission.userId,
      connectionId: input.admission.connectionId,
      current,
      replay: {
        sql: `SELECT 1 FROM oauth_refresh_credentials WHERE ${bound.sql} AND consumed_at_ms IS NOT NULL
          AND EXISTS (SELECT 1 FROM oauth_connections WHERE id = ? AND revoked_at_ms IS NULL AND expires_at_ms > ?)`,
        params: [...bound.params, input.admission.connectionId, current],
      },
    });
    yield* dbWork(() =>
      input.db.batch([
        input.db.prepare(evidence.sql).bind(...evidence.params),
        assertion(input.db),
        input.db
          .prepare(
            "UPDATE oauth_connections SET revoked_at_ms = ? WHERE id = ? AND user_id = ? AND revoked_at_ms IS NULL AND changes() = 1"
          )
          .bind(current, input.admission.connectionId, input.admission.userId),
        assertion(input.db),
      ])
    );
  });
export const findGrant = ({
  input,
  current,
}: Readonly<{ input: RefreshInput; current: number }>): Effect.Effect<
  GrantRow,
  BootstrapUnavailable | Schema.SchemaError
> =>
  Effect.gen(function* () {
    const found = yield* dbWork(() =>
      input.db
        .prepare(`SELECT g.expires_at_ms,r.scopes_json,r.consumed_at_ms FROM oauth_refresh_credentials r JOIN oauth_connections g ON g.id = r.connection_id
    WHERE r.id = ? AND r.user_id = ? AND r.digest = ? AND g.id = ? AND g.user_id = r.user_id AND g.client_id = ? AND g.resource = ?
      AND g.revoked_at_ms IS NULL AND g.expires_at_ms > ? AND g.refresh_allowed = 1`)
        .bind(
          input.admission.credentialId,
          input.admission.userId,
          new Uint8Array(input.admission.digest),
          input.admission.connectionId,
          input.admission.clientId,
          input.admission.resource,
          current
        )
        .first()
    );
    return yield* Schema.decodeUnknownEffect(GrantRow)(found);
  });
export const prepareIssuance = (
  input: Readonly<{ current: number; grant: GrantRow; scopes: PATScopes }>
): Effect.Effect<Issuance, Schema.SchemaError | PlatformError.PlatformError> =>
  Effect.gen(function* () {
    const access = yield* newSecret;
    const refresh = yield* newSecret;
    const accessDigest = yield* secretDigest({ purpose: "oauth-access", value: access });
    const refreshDigest = yield* secretDigest({ purpose: "oauth-refresh", value: refresh });
    const expirations = decideOAuthCredentialExpirations({
      current: input.current,
      grantExpiresAt: input.grant.expires_at_ms,
    });
    const body = yield* Schema.encodeEffect(TokenResponse)({
      access_token: Redacted.value(access),
      refresh_token: Redacted.value(refresh),
      token_type: "Bearer",
      expires_in: Math.floor((expirations.accessExpiresAt - input.current) / secondMs),
      scope: input.scopes.join(" "),
    });
    return {
      ...expirations,
      accessDigest,
      refreshDigest,
      refreshId: newId(),
      body,
      scopesJson: yield* Schema.encodeEffect(Schema.fromJsonString(PATScopes))(input.scopes),
    };
  });
const issuanceStatements = (
  input: RefreshInput,
  current: number,
  issuance: Issuance
): ReadonlyArray<D1PreparedStatement> => [
  input.db
    .prepare(
      "INSERT INTO oauth_access_credentials(id,connection_id,user_id,digest,issued_at_ms,expires_at_ms,scopes_json) VALUES (?,?,?,?,?,?,?)"
    )
    .bind(
      newId(),
      input.admission.connectionId,
      input.admission.userId,
      issuance.accessDigest,
      current,
      issuance.accessExpiresAt,
      issuance.scopesJson
    ),
  assertion(input.db),
  input.db
    .prepare(
      "INSERT INTO oauth_refresh_credentials(id,connection_id,user_id,digest,issued_at_ms,expires_at_ms,scopes_json) VALUES (?,?,?,?,?,?,?)"
    )
    .bind(
      issuance.refreshId,
      input.admission.connectionId,
      input.admission.userId,
      issuance.refreshDigest,
      current,
      issuance.refreshExpiresAt,
      issuance.scopesJson
    ),
  assertion(input.db),
  input.db
    .prepare(
      "INSERT INTO oauth_refresh_events(id,user_id,connection_id,consumed_credential_id,issued_credential_id,occurred_at_ms) VALUES (?,?,?,?,?,?)"
    )
    .bind(
      newId(),
      input.admission.userId,
      input.admission.connectionId,
      input.admission.credentialId,
      issuance.refreshId,
      current
    ),
  assertion(input.db),
];

export const commitRotation = ({
  input,
  grant,
  issuance,
}: Readonly<{ input: RefreshInput; grant: GrantRow; issuance: Issuance }>): Effect.Effect<
  void,
  BootstrapUnavailable
> =>
  Effect.gen(function* () {
    const current = yield* Clock.currentTimeMillis;
    const bound = boundCredential(input.admission);
    const consumption = protectConsentStatement({
      subject: { _tag: "User", userId: input.admission.userId },
      requirement: "active",
      statement: {
        sql: `UPDATE oauth_refresh_credentials SET consumed_at_ms = ? WHERE ${bound.sql} AND consumed_at_ms IS NULL AND expires_at_ms > ?
      AND scopes_json = ? AND EXISTS (SELECT 1 FROM oauth_connections g WHERE g.id = ? AND g.revoked_at_ms IS NULL AND g.expires_at_ms > ?
        AND NOT EXISTS (SELECT 1 FROM json_each(?) s WHERE NOT EXISTS (SELECT 1 FROM json_each(g.scopes_json) a WHERE a.value = s.value)))`,
        params: [
          current,
          ...bound.params,
          current,
          grant.scopes_json,
          input.admission.connectionId,
          current,
          issuance.scopesJson,
        ],
      },
    });
    return yield* dbWork(() =>
      input.db.batch([
        input.db.prepare(consumption.sql).bind(...consumption.params),
        assertion(input.db),
        ...issuanceStatements(input, current, issuance),
      ])
    ).pipe(Effect.asVoid);
  });
export const refreshCancelled = ({
  input,
  current,
}: Readonly<{ input: RefreshInput; current: number }>): boolean =>
  input.signal.aborted || current >= input.admission.deadlineAtMs;
