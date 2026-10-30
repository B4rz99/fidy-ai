import type { ProcessingConsentStatus } from "../../../src/shell/processing-consent/contract";
import {
  decodeProcessingConsentStatusRead,
  prepareInitialProcessingConsentRead,
} from "../../../src/shell/processing-consent/operations";
import { protectConsentStatement } from "../../../src/shell/consent/operations";
import { type Cause, Effect, Option, Schema } from "effect";
import { UserId } from "../../../src/core/identity/contract";
import { WebSessionId } from "../../../src/core/web-session/contract";
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

/** The lookup and legal receipt observe one live credential in the same native read. */
export const observeEntry = (
  input: Omit<WebSessionAuthentication, "freshness">
): Effect.Effect<
  Option.Option<Readonly<{ subject: AuthenticatedWebSession; status: ProcessingConsentStatus }>>,
  Cause.UnknownError | Schema.SchemaError
> =>
  Effect.gen(function* () {
    const token = sessionCookie(input.request);
    if (Option.isNone(token)) return Option.none();
    const digest = yield* Effect.tryPromise(() => sessionDigest(token.value));
    const read = prepareInitialProcessingConsentRead({ digest, current: input.current });
    const rows = yield* Effect.tryPromise(() =>
      input.db
        .prepare(read.sql)
        .bind(...read.params)
        .all()
    );
    const session = Schema.decodeUnknownOption(Session)(rows.results[0]);
    if (Option.isNone(session)) return Option.none();
    const status = yield* decodeProcessingConsentStatusRead(rows.results);
    return Option.map(status, (value) => ({
      subject: { ...session.value, digest },
      status: value,
    }));
  });
