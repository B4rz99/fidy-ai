import { Effect, type PlatformError, Redacted, Schema } from "effect";
import { Base64Url } from "effect/encoding";
import { OAuthRedirect, oauthResource } from "../../../src/shell/oauth-agents/contract";
import { PATScopes } from "../../../src/core/tokens/contract";
import { decideOAuthCredentialExpirations } from "../../../src/core/oauth-agents/operations";
import {
  OAuthClientId,
  OAuthConnectionId,
  type OAuthCredentialExpirations,
} from "../../../src/core/oauth-agents/contract";
import { UserId } from "../../../src/core/identity/contract";
import type { OwnedStatement } from "../../../src/shell/owner-write/contract";
import { RequestBodyPolicy } from "../../http/contract";
import { readBoundedRequestBody } from "../../http/operations";
import { digestBytes, newId, newSecret, secretDigest } from "../../secret-material/operations";
import { protectConsentStatement } from "../../../src/shell/consent/operations";
import { prepareOwnedStatement } from "../../database/operations";
import { BootstrapInvalid, type BootstrapUnavailable, dbWork } from "./bootstrap";
import { oauthResponse } from "./response";
import { forwardRefresh } from "./refresh";

const CodeExchange = Schema.Struct({
  grant_type: Schema.Literal("authorization_code"),
  code: Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]{43}$/u)),
  client_id: OAuthClientId,
  redirect_uri: OAuthRedirect,
  resource: Schema.Literal(oauthResource),
  code_verifier: Schema.String.check(Schema.isPattern(/^[A-Za-z0-9._~-]{43,128}$/u)),
});
type CodeExchange = typeof CodeExchange.Type;
const maximumScopeLength = 64;
const RefreshExchange = Schema.Struct({
  grant_type: Schema.Literal("refresh_token"),
  refresh_token: Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]{43}$/u)),
  client_id: OAuthClientId,
  resource: Schema.Literal(oauthResource),
  scope: Schema.OptionFromOptionalKey(
    Schema.NonEmptyString.check(Schema.isMaxLength(maximumScopeLength))
  ),
});
const TokenExchange = Schema.Union([CodeExchange, RefreshExchange]);
const CodeRow = Schema.Struct({
  connection_id: OAuthConnectionId,
  user_id: UserId,
  expires_at_ms: Schema.Int,
  scopes_json: Schema.String,
});
type CodeRow = typeof CodeRow.Type;
const TokenResponse = Schema.Struct({
  access_token: Schema.String,
  refresh_token: Schema.String,
  token_type: Schema.Literal("Bearer"),
  expires_in: Schema.Int,
  scope: Schema.String,
});
const bodyPolicy = Schema.decodeSync(RequestBodyPolicy)({
  maximumBytes: 16384,
  deadlineMilliseconds: 3000,
});
const secondMs = 1000;
const tokenDeadlineMs = 5000;
type ExchangeInput = Readonly<{
  request: Request;
  db: D1Database;
  current: number;
  coordinator: Readonly<{ getByName: (name: string) => Pick<Fetcher, "fetch"> }>;
  admitUser: (userId: string) => Effect.Effect<void, BootstrapUnavailable>;
}>;
type CodeProof = Readonly<{ payload: CodeExchange; digest: Uint8Array; challenge: string }>;
type Issuance = OAuthCredentialExpirations &
  Readonly<{
    accessDigest: Uint8Array;
    refreshDigest: Uint8Array;
  }>;
const invalidGrant = (): Response =>
  oauthResponse({ body: { error: "invalid_grant" }, status: 400 });
const decodeExchange = (
  request: Request
): Effect.Effect<typeof TokenExchange.Type, BootstrapInvalid> =>
  Effect.gen(function* () {
    const bytes = yield* readBoundedRequestBody(request, bodyPolicy);
    const text = yield* Effect.try(() => new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    const fields = new URLSearchParams(text);
    if (new Set(fields.keys()).size !== Array.from(fields.keys()).length) {
      return yield* new BootstrapInvalid();
    }
    return yield* Schema.decodeUnknownEffect(TokenExchange, { onExcessProperty: "error" })(
      Object.fromEntries(fields)
    );
  }).pipe(Effect.mapError(() => new BootstrapInvalid()));
const findGrant = (
  input: ExchangeInput,
  proof: CodeProof
): Effect.Effect<CodeRow, BootstrapUnavailable | Schema.SchemaError> =>
  Effect.gen(function* () {
    const found = yield* dbWork(() =>
      input.db
        .prepare(`SELECT g.id AS connection_id,g.user_id,g.expires_at_ms,g.scopes_json
    FROM oauth_codes c JOIN oauth_connections g ON g.id = c.connection_id WHERE c.digest = ?
    AND c.challenge = ? AND c.consumed_at_ms IS NULL AND c.expires_at_ms > ? AND g.client_id = ?
    AND g.redirect_uri = ? AND g.resource = ? AND g.revoked_at_ms IS NULL AND g.expires_at_ms > ?`)
        .bind(
          proof.digest,
          proof.challenge,
          input.current,
          proof.payload.client_id,
          proof.payload.redirect_uri,
          proof.payload.resource,
          input.current
        )
        .first()
    );
    return yield* Schema.decodeUnknownEffect(CodeRow)(found);
  });
const consumptionStatement = (
  input: ExchangeInput,
  proof: CodeProof,
  grant: CodeRow
): OwnedStatement =>
  protectConsentStatement({
    subject: { _tag: "User", userId: grant.user_id },
    requirement: "active",
    statement: {
      sql: `UPDATE oauth_codes SET consumed_at_ms = ? WHERE digest = ? AND connection_id = ?
    AND consumed_at_ms IS NULL AND expires_at_ms > ? AND challenge = ?
    AND EXISTS (SELECT 1 FROM oauth_connections WHERE id = ? AND user_id = ? AND client_id = ?
      AND redirect_uri = ? AND resource = ? AND revoked_at_ms IS NULL AND expires_at_ms > ?)`,
      params: [
        input.current,
        proof.digest,
        grant.connection_id,
        input.current,
        proof.challenge,
        grant.connection_id,
        grant.user_id,
        proof.payload.client_id,
        proof.payload.redirect_uri,
        proof.payload.resource,
        input.current,
      ],
    },
  });
const commitExchange = ({
  input,
  proof,
  grant,
  issuance,
}: Readonly<{
  input: ExchangeInput;
  proof: CodeProof;
  grant: CodeRow;
  issuance: Issuance;
}>): Effect.Effect<unknown, BootstrapUnavailable> =>
  dbWork(() =>
    input.db.batch([
      prepareOwnedStatement({ db: input.db, statement: consumptionStatement(input, proof, grant) }),
      input.db
        .prepare(
          `INSERT INTO oauth_access_credentials (id,connection_id,user_id,digest,issued_at_ms,expires_at_ms,scopes_json) SELECT ?,?,?,?,?,?,? WHERE changes() = 1`
        )
        .bind(
          newId(),
          grant.connection_id,
          grant.user_id,
          issuance.accessDigest,
          input.current,
          issuance.accessExpiresAt,
          grant.scopes_json
        ),
      input.db
        .prepare(
          `INSERT INTO oauth_refresh_credentials (id,connection_id,digest,issued_at_ms,expires_at_ms,user_id,scopes_json) SELECT ?,?,?,?,?,?,? WHERE changes() = 1`
        )
        .bind(
          newId(),
          grant.connection_id,
          issuance.refreshDigest,
          input.current,
          issuance.refreshExpiresAt,
          grant.user_id,
          grant.scopes_json
        ),
      input.db.prepare(
        "INSERT INTO oauth_atomic_assertion VALUES (1,CASE WHEN changes() = 1 THEN 1 ELSE 0 END) ON CONFLICT(id) DO UPDATE SET accepted = excluded.accepted"
      ),
    ])
  );
/** Exchanges a bound single-use code; failed atomic issuance leaves the code unconsumed. */
export const exchangeToken = (
  input: ExchangeInput
): Effect.Effect<Response, BootstrapInvalid | BootstrapUnavailable | PlatformError.PlatformError> =>
  Effect.gen(function* () {
    if (
      input.request.headers.get("content-type")?.split(";")[0] !==
      "application/x-www-form-urlencoded"
    ) {
      return invalidGrant();
    }
    const payload = yield* decodeExchange(input.request);
    if (payload.grant_type === "refresh_token") {
      return yield* forwardRefresh({
        ...input,
        payload,
        deadlineAtMs: input.current + tokenDeadlineMs,
      });
    }
    const digest = yield* secretDigest({
      purpose: "oauth-code",
      value: Redacted.make(payload.code),
    });
    const challenge = Base64Url.encode(
      yield* digestBytes(new TextEncoder().encode(payload.code_verifier))
    );
    const proof = { payload, digest, challenge };
    const grant = yield* findGrant(input, proof);
    const scopes = yield* Schema.decodeEffect(Schema.fromJsonString(PATScopes))(grant.scopes_json);
    const access = yield* newSecret;
    const refresh = yield* newSecret;
    const accessDigest = yield* secretDigest({ purpose: "oauth-access", value: access });
    const refreshDigest = yield* secretDigest({ purpose: "oauth-refresh", value: refresh });
    const { accessExpiresAt, refreshExpiresAt } = decideOAuthCredentialExpirations({
      current: input.current,
      grantExpiresAt: grant.expires_at_ms,
    });
    const body = yield* Schema.encodeEffect(TokenResponse)({
      access_token: Redacted.value(access),
      refresh_token: Redacted.value(refresh),
      token_type: "Bearer",
      expires_in: Math.floor((accessExpiresAt - input.current) / secondMs),
      scope: scopes.join(" "),
    });
    yield* commitExchange({
      input,
      proof,
      grant,
      issuance: { accessDigest, refreshDigest, accessExpiresAt, refreshExpiresAt },
    });
    return oauthResponse({ body, status: 200 });
  }).pipe(Effect.catchCause(() => Effect.succeed(invalidGrant())));
