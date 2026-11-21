import { ConsentSubject } from "~/shell/consent/contract";
import { Option } from "effect";
import type { OAuthAuthority, OAuthCaller } from "./contract";
import {
  protectConsentAuthority,
  protectOAuthGrantConsentAuthority,
} from "~/shell/consent/operations";

export const liveOAuthAuthority = (
  input: Readonly<{ subject: OAuthCaller; current: number }>
): OAuthAuthority => {
  const { subject, current } = input;
  const scope = Option.toArray(subject.requiredScope);

  return protectConsentAuthority({
    subject: ConsentSubject.User({ userId: subject.userId }),
    requirement: "active",
    authority: protectOAuthGrantConsentAuthority({
      subject: { userId: subject.userId, connectionId: subject.oauthConnectionId },
      authority: {
        table: "oauth_credentials",
        attribution: {
          userId: subject.userId,
          connectionId: subject.oauthConnectionId,
          credentialId: subject.credentialId,
        },
        predicate: `kind='access' AND id = ? AND user_id = ? AND digest = ? AND connection_id = ? AND expires_at_ms > ?
        AND EXISTS (SELECT 1 FROM oauth_connections g WHERE g.id = oauth_credentials.connection_id
          AND g.user_id = oauth_credentials.user_id AND g.client_id = ? AND g.resource = ?
          AND g.revoked_at_ms IS NULL AND g.expires_at_ms > ?
          ${scope.map(() => "AND EXISTS (SELECT 1 FROM json_each(g.scopes_json) WHERE value = ?)").join(" ")})
        ${scope.map(() => "AND EXISTS (SELECT 1 FROM json_each(oauth_credentials.scopes_json) WHERE value = ?)").join(" ")} `,
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

const databaseCurrentMillis = `CAST(strftime('%s', 'now') AS INTEGER) * 1000
  + CAST(substr(strftime('%f', 'now'), 4, 3) AS INTEGER)`;

export const liveOAuthCommitAuthority = (
  input: Readonly<{ subject: OAuthCaller; current: number }>
): OAuthAuthority => {
  const authority = liveOAuthAuthority(input);

  return {
    ...authority,
    predicate: `${authority.predicate}
      AND expires_at_ms > (${databaseCurrentMillis})
      AND EXISTS (SELECT 1 FROM oauth_connections g
        WHERE g.id = oauth_credentials.connection_id
          AND g.expires_at_ms > (${databaseCurrentMillis}))`,
  };
};
