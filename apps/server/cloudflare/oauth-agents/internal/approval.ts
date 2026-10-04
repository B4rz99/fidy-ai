import { DateTime, Effect, type PlatformError, Redacted, Schema } from "effect";
import { OAuthConnectionId } from "../../../src/core/oauth-agents/contract";
import {
  isReviewedOAuthExpiration,
  oauthAuthorizationCodeExpiresAt,
} from "../../../src/core/oauth-agents/operations";
import { PATScopes } from "../../../src/core/tokens/contract";
import {
  type OAuthAuthorization,
  OAuthConnected,
  type OAuthRegistration,
  type OAuthReviewChoice,
  oauthIssuer,
} from "../../../src/shell/oauth-agents/contract";
import type { FreshSessionSubject } from "../../../src/shell/web-session/contract";
import type { OwnedStatement } from "../../../src/shell/owner-write/contract";
import { freshSessionConditions } from "../../../src/shell/web-session/operations";
import { grantOAuthConsent, protectConsentStatement } from "../../../src/shell/consent/operations";
import { prepareOwnedStatement } from "../../database/operations";
import { newId, newSecret, secretDigest } from "../../secret-material/operations";
import { type BootstrapUnavailable, dbWork, invalidRequest } from "./bootstrap";
import { oauthResponse } from "./response";

type ApprovalInput = Readonly<{
  db: D1Database;
  current: number;
  session: FreshSessionSubject;
  pending: OAuthAuthorization;
  client: OAuthRegistration;
  choice: OAuthReviewChoice;
}>;
type ApprovalMaterial = Readonly<{
  connectionId: OAuthConnectionId;
  scopesJson: string;
  expiresAt: number;
  digest: Uint8Array;
}>;
const grantStatement = (input: ApprovalInput, material: ApprovalMaterial): OwnedStatement => {
  const fresh = freshSessionConditions(input);
  return protectConsentStatement({
    subject: { _tag: "User", userId: input.session.user_id },
    requirement: "active",
    statement: {
      sql: `INSERT INTO oauth_connections (id,request_id,user_id,client_id,claimed_client_name,redirect_uri,resource,scopes_json,approved_at_ms,expires_at_ms,refresh_allowed)
      SELECT ?,?,user_id,client_id,?,?,?,?,?,?,? FROM oauth_review_requests
      WHERE id = ? AND user_id = ? AND state = 'pending' AND expires_at_ms > ? AND ${fresh.sql}`,
      params: [
        material.connectionId,
        input.choice.requestId,
        input.client.client_name,
        input.pending.redirect_uri,
        input.pending.resource,
        material.scopesJson,
        input.current,
        material.expiresAt,
        input.client.grant_types?.includes("refresh_token") === true ? 1 : 0,
        input.choice.requestId,
        input.session.user_id,
        input.current,
        ...fresh.params,
      ],
    },
  });
};
const commitApproval = (
  input: ApprovalInput,
  material: ApprovalMaterial
): Effect.Effect<unknown, BootstrapUnavailable> =>
  dbWork(() =>
    input.db.batch([
      prepareOwnedStatement({ db: input.db, statement: grantStatement(input, material) }),
      prepareOwnedStatement({
        db: input.db,
        statement: grantOAuthConsent({
          id: newId(),
          connectionId: material.connectionId,
          session: input.session,
          current: input.current,
          scopes: input.choice.scopes,
          expiresAt: material.expiresAt,
        }),
      }),
      input.db
        .prepare(
          `INSERT INTO oauth_codes (digest,connection_id,challenge,expires_at_ms) SELECT ?,?,?,? WHERE changes() = 1`
        )
        .bind(
          material.digest,
          material.connectionId,
          input.pending.code_challenge,
          oauthAuthorizationCodeExpiresAt(input.current)
        ),
      input.db
        .prepare("DELETE FROM oauth_review_requests WHERE id = ? AND user_id = ? AND changes() = 1")
        .bind(input.choice.requestId, input.session.user_id),
      input.db.prepare(
        "INSERT INTO oauth_atomic_assertion VALUES (1, CASE WHEN changes() = 1 THEN 1 ELSE 0 END) ON CONFLICT(id) DO UPDATE SET accepted = excluded.accepted"
      ),
    ])
  );
/** Publishes the exact reviewed grant, Consent and callback code as one indivisible unit. */
export const approveRequest = (
  input: ApprovalInput
): Effect.Effect<
  Response,
  BootstrapUnavailable | PlatformError.PlatformError | Schema.SchemaError
> =>
  Effect.gen(function* () {
    const reviewedAt = DateTime.toEpochMillis(input.choice.reviewedAt);
    const expiresAt = DateTime.toEpochMillis(input.choice.expiresAt);
    if (
      !isReviewedOAuthExpiration({
        current: input.current,
        reviewedAt,
        expiresAt,
        lifetimeDays: input.choice.lifetimeDays,
      })
    ) {
      return invalidRequest();
    }
    const connectionId = OAuthConnectionId.make(newId());
    const code = yield* newSecret;
    const digest = yield* secretDigest({ purpose: "oauth-code", value: code });
    const scopesJson = yield* Schema.encodeEffect(Schema.fromJsonString(PATScopes))(
      input.choice.scopes
    );
    const callback = new URL(input.pending.redirect_uri);
    callback.searchParams.set("code", Redacted.value(code));
    callback.searchParams.set("iss", oauthIssuer);
    if (input.pending.state !== undefined) callback.searchParams.set("state", input.pending.state);
    const body = yield* Schema.encodeEffect(OAuthConnected)({
      connectionId,
      callback: callback.href,
    });
    yield* commitApproval(input, { connectionId, digest, scopesJson, expiresAt });
    return oauthResponse({ body, status: 200 });
  });
