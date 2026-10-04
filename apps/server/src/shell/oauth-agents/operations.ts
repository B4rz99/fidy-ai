import { Option } from "effect";
import type { OAuthAuthority, OAuthCaller } from "./contract";
import {
  protectConsentAuthority,
  protectOAuthGrantConsentAuthority,
} from "~/shell/consent/operations";
/** Require the admitted User, client, resource, credential, exact scope and immutable grant at the action instant. */
export const liveOAuthAuthority = (
  input: Readonly<{ subject: OAuthCaller; current: number }>
): OAuthAuthority => {
  const { subject, current } = input;
  const scope = Option.toArray(subject.requiredScope);
  return protectConsentAuthority({
    subject: { _tag: "User", userId: subject.userId },
    requirement: "active",
    authority: protectOAuthGrantConsentAuthority({
      subject: { userId: subject.userId, connectionId: subject.oauthConnectionId },
      authority: {
        table: "oauth_access_credentials",
        attribution: {
          userId: subject.userId,
          connectionId: subject.oauthConnectionId,
          credentialId: subject.credentialId,
        },
        predicate: `id = ? AND user_id = ? AND digest = ? AND connection_id = ? AND expires_at_ms > ?
        AND EXISTS (SELECT 1 FROM oauth_connections g WHERE g.id = oauth_access_credentials.connection_id
          AND g.user_id = oauth_access_credentials.user_id AND g.client_id = ? AND g.resource = ?
          AND g.revoked_at_ms IS NULL AND g.expires_at_ms > ?
          ${scope.map(() => "AND EXISTS (SELECT 1 FROM json_each(g.scopes_json) WHERE value = ?)").join(" ")})
        ${scope.map(() => "AND EXISTS (SELECT 1 FROM json_each(oauth_access_credentials.scopes_json) WHERE value = ?)").join(" ")} `,
        bindings: [
          subject.credentialId,
          subject.userId,
          subject.digest,
          subject.oauthConnectionId,
          current,
          subject.clientId,
          subject.resource,
          current,
          ...scope,
          ...scope,
        ],
      },
    }),
  });
};
