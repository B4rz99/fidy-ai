import type { FreshSessionSubject } from "../../../src/shell/web-session/contract";
import { freshSessionExists, freshSessionParams } from "../../../src/shell/web-session/operations";
import { Clock, DateTime, Effect, Option } from "effect";
import { newId } from "../../secret-material/operations";
import { recoveryCodeDigest, sampleRecoveryCode } from "./material";
import { freshBrowserSession } from "../../web-session/operations";

const unavailable = (): Response => Response.json({ status: "unavailable" }, { status: 503 });
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
const attempt = <A>(run: () => Promise<A>): Effect.Effect<A, void> =>
  Effect.tryPromise({ try: run, catch: () => undefined });
const instant = (epochMs: number): string => DateTime.formatIso(DateTime.makeUnsafe(epochMs));
const json = (body: object, status = 200, headers?: HeadersInit): Response => {
  const responseHeaders = new Headers(headers);
  responseHeaders.set("cache-control", "no-store");
  return Response.json(body, { status, headers: responseHeaders });
};

/** Require a still-fresh browser session before rotating its User's emergency proof. */
export const rotateBackupRecoveryCode = ({
  request,
  db,
}: {
  request: Request;
  db: D1Database;
}): Promise<Response> =>
  Effect.runPromise(
    Effect.gen(function* () {
      const usedAt = yield* Clock.currentTimeMillis;
      const session = yield* attempt(() => freshBrowserSession({ request, db, current: usedAt }));
      if (Option.isNone(session)) return noSession();
      return yield* rotateFreshSessionProof(db, session.value, usedAt);
    }).pipe(Effect.catchCause(() => Effect.succeed(unavailable())))
  );

const rotateFreshSessionProof = (
  db: D1Database,
  session: FreshSessionSubject,
  usedAt: number
): Effect.Effect<Response, void> =>
  Effect.gen(function* () {
    const code = sampleRecoveryCode();
    const codeDigest = yield* attempt(() => recoveryCodeDigest(code));
    const rotated = yield* attempt(() =>
      db.batch([
        db
          .prepare(
            `UPDATE backup_recovery_credentials SET code_digest = ?, created_at_ms = ?,
        consumed_at_ms = NULL, revision = revision + 1
        WHERE user_id = ? AND ${freshSessionExists}`
          )
          .bind(
            codeDigest,
            usedAt,
            session.user_id,
            ...freshSessionParams({ session, time: usedAt })
          ),
        db
          .prepare(
            `INSERT INTO canonical_security_mutations (id, user_id, session_id, operation, occurred_at_ms)
        SELECT ?, ?, ?, 'recovery.rotateBackupRecoveryCode', ? WHERE changes() = 1`
          )
          .bind(newId(), session.user_id, session.id, usedAt),
      ])
    );
    if (rotated[0]?.meta.changes !== 1 || rotated[1]?.meta.changes !== 1) {
      return noSession();
    }
    return json({
      data: {
        status: "rotated",
        backupRecoveryCode: code,
        rotatedAt: instant(usedAt),
      },
      next: [],
    });
  });
