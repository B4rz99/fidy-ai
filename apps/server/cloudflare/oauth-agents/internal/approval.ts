import { ConsentSubject } from "./consent-subject";
import { type OAuthConnectionId } from "../../../src/core/oauth-agents/contract";
import {
  type OAuthAuthorization,
  type OAuthRegistration,
  type OAuthReviewChoice,
} from "../../../src/shell/oauth-agents/contract";
import type { FreshSessionSubject } from "../../../src/shell/web-session/contract";
import type { OwnedStatement } from "../../../src/shell/owner-write/contract";
import { freshSessionConditions } from "../../../src/shell/web-session/operations";
import { protectConsentStatement } from "../../../src/shell/consent/operations";

type ApprovalInput = Readonly<{
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

export const grantStatement = ({
  input,
  material,
}: {
  input: ApprovalInput;
  material: ApprovalMaterial;
}): OwnedStatement => {
  const fresh = freshSessionConditions(input);

  return protectConsentStatement({
    subject: ConsentSubject.User({ userId: input.session.user_id }),
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
