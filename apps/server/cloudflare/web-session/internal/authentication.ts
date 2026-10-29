import { protectConsentStatement } from "../../../src/shell/consent/operations";
import { Option, Schema } from "effect";
import { UserId } from "../../../src/core/identity/contract";
import { WebSessionId } from "../../../src/core/web-session/contract";
import type {
  AuthenticatedWebSession,
  BoundWebSessionLookup,
  WebSessionAuthentication,
} from "../contract";
import { sessionCookie, sessionDigest } from "./credentials";

const Session = Schema.Struct({ id: WebSessionId, userId: UserId });

export const decodeSessionLookup = ({
  lookup,
  row,
}: Readonly<{
  lookup: BoundWebSessionLookup;
  row: unknown;
}>): Option.Option<AuthenticatedWebSession> =>
  Option.map(Schema.decodeUnknownOption(Session)(row), (session) => ({
    ...session,
    digest: lookup.digest,
  }));

export const prepareSessionLookup = ({
  request,
  current,
  freshness,
  requireConsent,
  binding,
}: Omit<WebSessionAuthentication, "db"> &
  Readonly<{
    requireConsent: boolean;
    binding: Option.Option<string>;
  }>): Promise<Option.Option<BoundWebSessionLookup>> => {
  const token = sessionCookie(request);
  if (Option.isNone(token)) return Promise.resolve(Option.none());
  return sessionDigest(token.value).then((digest) => {
    const statement = {
      sql: `SELECT id, user_id AS userId FROM web_sessions
        WHERE token_digest = ? AND revoked_at_ms IS NULL ${freshness === "fresh" ? "AND fresh_until_ms > ?" : ""}
          AND idle_expires_at_ms > ? AND hard_expires_at_ms > ?
          ${Option.isSome(binding) ? "AND id = ?" : ""}`,
      params: [
        digest,
        ...(freshness === "fresh" ? [current] : []),
        current,
        current,
        ...(Option.isSome(binding) ? [binding.value] : []),
      ],
    };
    return Option.some({
      digest,
      statement: requireConsent
        ? protectConsentStatement({
            statement,
            subject: { _tag: "Owner", column: "web_sessions.user_id" },
            requirement: "unrevoked",
          })
        : statement,
    });
  });
};

export const authenticate = ({
  request,
  db,
  current,
  freshness,
  requireConsent,
}: WebSessionAuthentication & Readonly<{ requireConsent: boolean }>): Promise<
  Option.Option<AuthenticatedWebSession>
> =>
  prepareSessionLookup({
    request,
    current,
    freshness,
    requireConsent,
    binding: Option.none(),
  }).then((lookup) => {
    if (Option.isNone(lookup)) return Option.none();
    const { statement } = lookup.value;
    return db
      .prepare(statement.sql)
      .bind(...statement.params)
      .first()
      .then((row) => decodeSessionLookup({ lookup: lookup.value, row }));
  });
