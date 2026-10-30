import type { ProcessingConsentStatus } from "../../../src/shell/processing-consent/contract";
import {
  decodeProcessingConsentStatusRead,
  prepareInitialProcessingConsentRead,
} from "../../../src/shell/processing-consent/operations";
import { protectConsentAuthority } from "../../../src/shell/consent/operations";
import { type Cause, Effect, Option, Schema } from "effect";
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
    const requested = {
      table: "web_sessions" as const,
      predicate: `token_digest = ? AND revoked_at_ms IS NULL ${freshness === "fresh" ? "AND fresh_until_ms > ?" : ""}
          AND idle_expires_at_ms > ? AND hard_expires_at_ms > ?
          ${Option.isSome(binding) ? "AND id = ?" : ""}`,
      bindings: [
        digest,
        ...(freshness === "fresh" ? [current] : []),
        current,
        current,
        ...(Option.isSome(binding) ? [binding.value] : []),
      ],
    };
    const authority = requireConsent
      ? protectConsentAuthority({
          authority: requested,
          subject: { _tag: "Owner", column: "web_sessions.user_id" },
          requirement: "unrevoked",
        })
      : requested;
    return Option.some({
      digest,
      authority,
      statement: {
        sql: `SELECT id, user_id AS userId FROM web_sessions WHERE ${authority.predicate}`,
        params: authority.bindings,
      },
    });
  });
};

export const authenticate = ({
  request,
  db,
  current,
  freshness,
  requireConsent,
  binding,
}: WebSessionAuthentication &
  Readonly<{ requireConsent: boolean; binding: Option.Option<string> }>): Promise<
  Option.Option<AuthenticatedWebSession>
> =>
  prepareSessionLookup({
    request,
    current,
    freshness,
    requireConsent,
    binding,
  }).then((lookup) => {
    if (Option.isNone(lookup)) return Option.none();
    const { statement } = lookup.value;
    return db
      .prepare(statement.sql)
      .bind(...statement.params)
      .first()
      .then((row) => decodeSessionLookup({ lookup: lookup.value, row }));
  });

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
