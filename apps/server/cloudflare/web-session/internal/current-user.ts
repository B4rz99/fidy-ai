import { webSessionCredentialAuthority } from "@fidy/server/web-session-operations";
import * as D1Client from "@effect/sql-d1/D1Client";
import { User } from "@fidy/server/identity-contract";
import { UserId } from "@fidy/server/identity-reference";
import { getCurrentUser } from "@fidy/server/identity-operations";
import { Clock, Context, DateTime, Effect, Exit, Layer, Option, Schema } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { webSessionIdleRenewalCandidate } from "../../../src/core/web-session/operations";
import { sessionCookie, sessionDigest, sessionSetCookie } from "./credentials";
import { attempt, json, noSession, unavailable, uuid } from "./support";

const HTTP_OK = 200;
const Session = Schema.Struct({ id: Schema.String.check(Schema.isUUID()), user_id: UserId });

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
        const digest = yield* attempt(() => sessionDigest(token.value));
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
          digest,
        });
      }
    }).pipe(Effect.catchCause(() => Effect.succeed(unavailable())))
  );

const projectCurrentUser = ({
  db,
  subject,
  session,
  token,
  digest,
}: {
  db: D1Database;
  subject: UserId;
  session: typeof Session.Type;
  token: string;
  digest: Uint8Array;
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
    const authority = webSessionCredentialAuthority({
      subject: { id: session.id, userId: subject, digest },
      current: observedAt,
    });
    const recorded = yield* attempt(() =>
      db
        .prepare(
          `INSERT INTO canonical_user_reads (id, user_id, session_id, occurred_at_ms)
          SELECT ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM ${authority.table} WHERE ${authority.predicate})`
        )
        .bind(uuid(), session.user_id, session.id, observedAt, ...authority.bindings)
        .run()
    );
    if (recorded.meta.changes !== 1) return noSession();
    const data = yield* Schema.encodeEffect(Schema.toCodecJson(User))(loaded.value.data).pipe(
      Effect.orDie
    );
    return json({
      body: { data, next: loaded.value.next },
      status: HTTP_OK,
      headers: {
        "set-cookie": sessionSetCookie(token),
      },
    });
  });
