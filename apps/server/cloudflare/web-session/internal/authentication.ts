import { protectConsentStatement } from "@fidy/server/consent-operations";
import { Option, Schema } from "effect";
import { UserId } from "@fidy/server/identity-reference";
import { WebSessionId } from "../../../src/core/web-session/reference";
import type { AuthenticatedWebSession, WebSessionAuthentication } from "../contract";
import { sessionCookie, sessionDigest } from "./credentials";

const Session = Schema.Struct({ id: WebSessionId, userId: UserId });

export const authenticate = ({
  request,
  db,
  current,
  freshness,
  requireConsent,
}: WebSessionAuthentication & Readonly<{ requireConsent: boolean }>): Promise<
  Option.Option<AuthenticatedWebSession>
> => {
  const token = sessionCookie(request);
  if (Option.isNone(token)) return Promise.resolve(Option.none());
  return sessionDigest(token.value).then((digest) => {
    const statement = {
      sql: `SELECT id, user_id AS userId FROM web_sessions
        WHERE token_digest = ? AND revoked_at_ms IS NULL ${freshness === "fresh" ? "AND fresh_until_ms > ?" : ""}
          AND idle_expires_at_ms > ? AND hard_expires_at_ms > ?`,
      params: [digest, ...(freshness === "fresh" ? [current] : []), current, current],
    };
    const authorized = requireConsent
      ? protectConsentStatement({
          statement,
          subject: { _tag: "Owner", column: "web_sessions.user_id" },
          requirement: "unrevoked",
        })
      : statement;
    return db
      .prepare(authorized.sql)
      .bind(...authorized.params)
      .first()
      .then((raw) =>
        Option.map(Schema.decodeUnknownOption(Session)(raw), (session) => ({ ...session, digest }))
      );
  });
};
