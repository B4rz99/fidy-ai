import * as D1Client from "@effect/sql-d1/D1Client";
import { User, UserId, getCurrentUser } from "@fidy/server/identity-runtime";
import {
  calculateWebSessionDeadlines,
  webSessionIdleRenewalCandidate,
} from "../../src/core/web-session/operations";
import {
  Clock,
  Context,
  Crypto,
  DateTime,
  Effect,
  Encoding,
  Exit,
  Layer,
  Option,
  PlatformError,
  Schema,
} from "effect";
import { maximumWrongVerifierAttempts } from "../../src/core/browser-login/rules";
import { SqlClient } from "effect/unstable/sql";

/** Resolve canonical browser authority without extending idle life or bypassing Consent. */
export const canonicalBrowserSession = ({
  request,
  db,
}: Readonly<{ request: Request; db: D1Database }>): Promise<
  Option.Option<Readonly<{ id: string; userId: string; digest: Uint8Array }>>
> =>
  Effect.runPromise(
    Effect.gen(function* () {
      const cookie = sessionCookie(request);
      if (Option.isNone(cookie)) return Option.none();
      const digest = yield* attempt(() => sha256(cookie.value));
      const current = yield* Clock.currentTimeMillis;
      const raw = yield* attempt(() =>
        db
          .prepare(`SELECT id, user_id FROM web_sessions
      WHERE token_digest = ? AND revoked_at_ms IS NULL AND idle_expires_at_ms > ? AND hard_expires_at_ms > ?
      AND NOT EXISTS (SELECT 1 FROM consent_user_revocations WHERE user_id = web_sessions.user_id)`)
          .bind(digest, current, current)
          .first()
      );
      return Option.map(Schema.decodeUnknownOption(Session)(raw), (session) => ({
        id: session.id,
        userId: session.user_id,
        digest,
      }));
    })
  );

const Session = Schema.Struct({
  id: Schema.String.check(Schema.isUUID()),
  user_id: Schema.String.check(Schema.isUUID()),
});

const sessionCookie = (request: Request): Option.Option<string> => {
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
const sha256 = (value: string): Promise<Uint8Array> =>
  crypto.subtle
    .digest("SHA-256", new TextEncoder().encode(value))
    .then((bytes) => new Uint8Array(bytes));
/** Revoke only the presented session, without disclosing whether the credential existed. */
export const logoutBrowser = ({
  request,
  db,
}: Readonly<{ request: Request; db: D1Database }>): Promise<Response> =>
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
const attempt = <A>(run: () => Promise<A>): Effect.Effect<A, void> =>
  Effect.tryPromise({ try: run, catch: () => undefined });

/** Resolve a live browser credential. Freshness is required only for authority-changing actions. */
export const browserSession = ({
  request,
  db,
  input,
}: Readonly<{
  request: Request;
  db: D1Database;
  input: Readonly<{ current: number; fresh: boolean }>;
}>): Promise<Option.Option<Readonly<{ id: string; userId: string }>>> =>
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
      return Option.map(Schema.decodeUnknownOption(Session)(row), (session) => ({
        id: session.id,
        userId: session.user_id,
      }));
    })
  );

const workerCrypto = Crypto.make({
  randomBytes: (size) => crypto.getRandomValues(new Uint8Array(size)),
  digest: (algorithm, data) =>
    Effect.tryPromise({
      try: () =>
        crypto.subtle
          .digest(algorithm, Uint8Array.from(data))
          .then((bytes) => new Uint8Array(bytes)),
      catch: (cause) =>
        PlatformError.systemError({
          _tag: "Unknown",
          module: "WorkerCrypto",
          method: "digest",
          cause,
        }),
    }),
});
const uuid = (): string => Effect.runSync(workerCrypto.randomUUIDv4.pipe(Effect.orDie));
const json = (body: object, status = 200, headers?: HeadersInit): Response => {
  const responseHeaders = new Headers(headers);
  responseHeaders.set("cache-control", "no-store");
  return Response.json(body, { status, headers: responseHeaders });
};

const noSession = (): Response =>
  Response.json(
    {
      error: {
        code: "unauthenticated",
        message: "Present a valid credential and retry.",
      },
      next: [],
    },
    { status: 401 }
  );

const unavailable = (): Response => Response.json({ status: "unavailable" }, { status: 503 });
const sessionSetCookie = (token: string): string =>
  `__Host-fidy_session=${token}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=2592000`;

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
      {
        const digest = yield* attempt(() => sha256(token.value));
        const usedAt = yield* Clock.currentTimeMillis;
        const candidate = webSessionIdleRenewalCandidate(DateTime.makeUnsafe(usedAt));
        const rawSession = yield* attempt(() =>
          db
            .prepare(
              `UPDATE web_sessions SET idle_expires_at_ms = min(hard_expires_at_ms,
        max(idle_expires_at_ms, ?)) WHERE token_digest = ? AND revoked_at_ms IS NULL
        AND idle_expires_at_ms > ? AND hard_expires_at_ms > ? RETURNING id, user_id`
            )
            .bind(DateTime.toEpochMillis(candidate), digest, usedAt, usedAt)
            .first()
        );
        if (rawSession === null) return noSession();
        const session = Schema.decodeUnknownOption(Session)(rawSession);
        if (Option.isNone(session)) return unavailable();
        const subject = Schema.decodeOption(UserId)(session.value.user_id);
        if (Option.isNone(subject)) return unavailable();
        return yield* projectCurrentUser({
          db,
          subject: subject.value,
          session: session.value,
          token: token.value,
        });
      }
    }).pipe(Effect.catchCause(() => Effect.succeed(unavailable())))
  );

const projectCurrentUser = ({
  db,
  subject,
  session,
  token,
}: {
  db: D1Database;
  subject: UserId;
  session: typeof Session.Type;
  token: string;
}): Effect.Effect<Response, void> =>
  Effect.gen(function* () {
    const loaded = yield* Effect.exit(
      Effect.scoped(
        Effect.gen(function* () {
          const clients = yield* Layer.build(D1Client.layer({ db }));
          return yield* getCurrentUser(subject).pipe(
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
        .bind(uuid(), session.user_id, session.id, observedAt)
        .run()
    );
    const data = yield* Schema.encodeEffect(Schema.toCodecJson(User))(loaded.value.data).pipe(
      Effect.orDie
    );
    return json({ data, next: loaded.value.next }, HTTP_OK, {
      "set-cookie": sessionSetCookie(token),
    });
  });

/** Establish one session after BrowserLoginPairing has verified its private proof; consumption and issuance are atomic. */
export const createWebSession = ({
  db,
  pairingId,
  current,
}: Readonly<{ db: D1Database; pairingId: string; current: number }>): Effect.Effect<
  Response,
  void
> =>
  Effect.gen(function* () {
    const token = Encoding.encodeBase64Url(crypto.getRandomValues(new Uint8Array(digestBytes)));
    const deadlines = calculateWebSessionDeadlines(DateTime.makeUnsafe(current));
    const tokenDigest = yield* attempt(() => sha256(token));
    const committed = yield* attempt(() =>
      db.batch([
        db
          .prepare(
            `UPDATE browser_login_pairings SET state = 'consumed' WHERE id = ? AND state = 'ready' AND expires_at_ms > ? AND wrong_attempts < ?`
          )
          .bind(pairingId, current, maximumWrongVerifierAttempts),
        db
          .prepare(
            `INSERT INTO web_sessions (id, pairing_id, user_id, token_digest, created_at_ms,
        fresh_until_ms, idle_expires_at_ms, hard_expires_at_ms)
      SELECT ?, p.id, p.user_id, ?, ?, ?, ?, ? FROM browser_login_pairings AS p
      WHERE p.id = ? AND p.state = 'consumed' AND p.user_id IS NOT NULL`
          )
          .bind(
            uuid(),
            tokenDigest,
            current,
            DateTime.toEpochMillis(deadlines.freshUntil),
            DateTime.toEpochMillis(deadlines.idleExpiresAt),
            DateTime.toEpochMillis(deadlines.hardExpiresAt),
            pairingId
          ),
      ])
    );
    if (committed[1]?.meta.changes !== 1) return invalid();
    return json({ status: "authenticated" }, HTTP_OK, {
      "set-cookie": sessionSetCookie(token),
    });
  });

const HTTP_OK = 200;
const digestBytes = 32;
const invalid = (): Response =>
  Response.json(
    {
      error: {
        code: "pairing_invalid",
        message: "Esta vinculación ya no es válida. Inicia de nuevo.",
      },
    },
    { status: 400 }
  );

/** Resolve the exact still-fresh browser credential for an account-security action. */
export const freshBrowserSession = ({
  request,
  db,
  current,
}: Readonly<{
  request: Request;
  db: D1Database;
  current: number;
}>): Promise<Option.Option<Readonly<{ id: string; userId: string }>>> =>
  browserSession({ request, db, input: { current, fresh: true } });
