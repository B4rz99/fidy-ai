import {
  User,
  UserId,
  getCurrentUser,
  webSessionIdleRenewalCandidate,
} from "@fidy/server/identity-runtime";
import * as D1Client from "@effect/sql-d1/D1Client";
import { Clock, Context, DateTime, Effect, Exit, Layer, Option, Schema } from "effect";
import { SqlClient } from "effect/unstable/sql";

// WebSession resolution remains with the WebSession owner (#596), not pairing or Recovery.
const Session = Schema.Struct({
  id: Schema.String.check(Schema.isUUID()),
  user_id: Schema.String.check(Schema.isUUID()),
});
const attempt = <A>(run: () => Promise<A>): Effect.Effect<A, void> =>
  Effect.tryPromise({ try: run, catch: () => undefined });
export const sha256 = (value: string): Promise<Uint8Array> =>
  crypto.subtle
    .digest("SHA-256", new TextEncoder().encode(value))
    .then((bytes) => new Uint8Array(bytes));
const unavailable = (): Response => Response.json({ status: "unavailable" }, { status: 503 });
const noSession = (): Response =>
  Response.json(
    {
      error: { code: "unauthenticated", message: "Present a valid credential and retry." },
      next: [],
    },
    { status: 401 }
  );
const sessionSetCookie = (token: string): string =>
  `__Host-fidy_session=${token}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=2592000`;
export const sessionCookie = (request: Request): Option.Option<string> => {
  const cookies =
    request.headers
      .get("cookie")
      ?.split(";")
      .map((value) => value.trim()) ?? [];
  const selected = cookies.filter((cookie) => cookie.startsWith("__Host-fidy_session="));
  if (selected.length !== 1) return Option.none();
  const value = selected[0]?.slice("__Host-fidy_session=".length) ?? "";
  return /^[A-Za-z0-9_-]{43}$/u.test(value) ? Option.some(value) : Option.none();
};

/** Resolve a live WebSession; account-security actions additionally require a fresh decision. */
export const browserSession = ({
  request,
  db,
  input,
}: {
  request: Request;
  db: D1Database;
  input: Readonly<{ current: number; fresh: boolean }>;
}): Promise<Option.Option<typeof Session.Type>> =>
  Effect.runPromise(
    Effect.gen(function* () {
      const token = sessionCookie(request);
      if (Option.isNone(token)) return Option.none();
      const tokenDigest = yield* attempt(() => sha256(token.value));
      const row = yield* attempt(() =>
        db
          .prepare(`SELECT id, user_id FROM web_sessions
    WHERE token_digest = ? AND revoked_at_ms IS NULL AND (? = 0 OR fresh_until_ms > ?)
      AND idle_expires_at_ms > ? AND hard_expires_at_ms > ?`)
          .bind(tokenDigest, input.fresh ? 1 : 0, input.current, input.current, input.current)
          .first()
      );
      return Schema.decodeUnknownOption(Session)(row);
    })
  );

/** Resolve the exact still-fresh browser session for an account-security action. */
export const freshBrowserSession = ({
  request,
  db,
  current,
}: {
  request: Request;
  db: D1Database;
  current: number;
}): Promise<Option.Option<typeof Session.Type>> =>
  browserSession({ request, db, input: { current, fresh: true } });

/** Return the canonical User projection only for a live, unrevoked WebSession. */
export const currentUser = ({
  request,
  db,
}: {
  request: Request;
  db: D1Database;
}): Promise<Response> =>
  Effect.runPromise(
    Effect.gen(function* () {
      const token = sessionCookie(request);
      if (Option.isNone(token)) return noSession();
      const digest = yield* attempt(() => sha256(token.value));
      const usedAt = yield* Clock.currentTimeMillis;
      const candidate = webSessionIdleRenewalCandidate(DateTime.makeUnsafe(usedAt));
      const rawSession = yield* attempt(() =>
        db
          .prepare(`UPDATE web_sessions SET idle_expires_at_ms = min(hard_expires_at_ms,
    max(idle_expires_at_ms, ?)) WHERE token_digest = ? AND revoked_at_ms IS NULL
    AND idle_expires_at_ms > ? AND hard_expires_at_ms > ? RETURNING id, user_id`)
          .bind(DateTime.toEpochMillis(candidate), digest, usedAt, usedAt)
          .first()
      );
      if (rawSession === null) return noSession();
      const session = Schema.decodeUnknownOption(Session)(rawSession);
      if (Option.isNone(session)) return unavailable();
      const subject = Schema.decodeOption(UserId)(session.value.user_id);
      if (Option.isNone(subject)) return unavailable();
      const loaded = yield* Effect.exit(
        Effect.scoped(
          Effect.gen(function* () {
            const clients = yield* Layer.build(D1Client.layer({ db }));
            return yield* getCurrentUser(subject.value).pipe(
              Effect.withTracerEnabled(false),
              Effect.provideService(SqlClient.SqlClient, Context.get(clients, SqlClient.SqlClient))
            );
          })
        )
      );
      if (Exit.isFailure(loaded)) return unavailable();
      const observedAt = yield* Clock.currentTimeMillis;
      yield* attempt(() =>
        db
          .prepare(
            `INSERT INTO canonical_user_reads (id, user_id, session_id, occurred_at_ms) VALUES (?, ?, ?, ?)`
          )
          .bind(crypto.randomUUID(), session.value.user_id, session.value.id, observedAt)
          .run()
      );
      const data = yield* Schema.encodeEffect(Schema.toCodecJson(User))(loaded.value.data).pipe(
        Effect.orDie
      );
      return Response.json(
        { data, next: loaded.value.next },
        { headers: { "cache-control": "no-store", "set-cookie": sessionSetCookie(token.value) } }
      );
    }).pipe(Effect.catchCause(() => Effect.succeed(unavailable())))
  );

/** Revoke the exact cookie's session without disclosing whether it existed. */
export const logoutBrowser = ({
  request,
  db,
}: {
  request: Request;
  db: D1Database;
}): Promise<Response> =>
  Effect.runPromise(
    Effect.gen(function* () {
      const token = sessionCookie(request);
      if (Option.isSome(token)) {
        const current = yield* Clock.currentTimeMillis;
        const tokenDigest = yield* attempt(() => sha256(token.value));
        yield* attempt(() =>
          db
            .prepare(
              `UPDATE web_sessions SET revoked_at_ms = ? WHERE token_digest = ? AND revoked_at_ms IS NULL`
            )
            .bind(current, tokenDigest)
            .run()
        );
      }
      return new Response(null, {
        status: 204,
        headers: {
          "set-cookie": "__Host-fidy_session=; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0",
          "cache-control": "no-store",
        },
      });
    })
  );
