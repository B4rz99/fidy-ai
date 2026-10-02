import type { WebSessionEstablishment } from "../contract";
import { Clock, DateTime, Effect, Encoding, Option, Schema } from "effect";
import { calculateWebSessionDeadlines } from "../../../src/core/web-session/operations";
import { sessionCookie, sessionDigest, sessionSetCookie } from "./credentials";
import { attempt, invalid, json, uuid } from "./support";
import { WebSessionBearer } from "../../../src/core/web-session/reference";

const HTTP_OK = 200;
const digestBytes = 32;

export const completePairing = ({
  db,
  claim,
}: WebSessionEstablishment): Effect.Effect<Response, void> =>
  Effect.gen(function* () {
    const current = claim.current;
    const token = Encoding.encodeBase64Url(crypto.getRandomValues(new Uint8Array(digestBytes)));
    const deadlines = calculateWebSessionDeadlines(DateTime.makeUnsafe(current));
    const tokenDigest = yield* attempt(() =>
      sessionDigest(Schema.decodeSync(WebSessionBearer)(token))
    );
    const committed = yield* attempt(() =>
      db.batch([
        db.prepare(claim.consume.sql).bind(...claim.consume.params),
        db
          .prepare(
            `INSERT INTO web_sessions (id, pairing_id, user_id, token_digest, created_at_ms,
        fresh_until_ms, idle_expires_at_ms, hard_expires_at_ms)
      SELECT ?, pairingId, userId, ?, ?, ?, ?, ? FROM (${claim.subject.sql})
      WHERE changes() = 1`
          )
          .bind(
            uuid(),
            tokenDigest,
            current,
            DateTime.toEpochMillis(deadlines.freshUntil),
            DateTime.toEpochMillis(deadlines.idleExpiresAt),
            DateTime.toEpochMillis(deadlines.hardExpiresAt),
            ...claim.subject.params
          ),
      ])
    );
    if (committed[1]?.meta.changes !== 1) return invalid();
    return json({
      body: { status: "authenticated" },
      status: HTTP_OK,
      headers: {
        "set-cookie": sessionSetCookie(token),
      },
    });
  });

/** Revoke the exact cookie's session without disclosing whether it existed. */
export const logout = ({ request, db }: { request: Request; db: D1Database }): Promise<Response> =>
  Effect.runPromise(
    Effect.gen(function* () {
      const token = sessionCookie(request);
      if (Option.isSome(token)) {
        const current = yield* Clock.currentTimeMillis;
        const tokenDigest = yield* attempt(() => sessionDigest(token.value));
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
