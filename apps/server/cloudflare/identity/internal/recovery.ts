import { BackupRecoveryCode } from "@fidy/server/client";
import type { FreshSessionSubject } from "@fidy/server/web-session-contract";
import { freshSessionExists, freshSessionParams } from "@fidy/server/web-session-operations";
import { Clock, Crypto, DateTime, Effect, Option, PlatformError, Schema } from "effect";
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
const sha256 = (value: string): Promise<Uint8Array> =>
  crypto.subtle
    .digest("SHA-256", new TextEncoder().encode(value))
    .then((digest) => new Uint8Array(digest));
const attempt = <A>(run: () => Promise<A>): Effect.Effect<A, void> =>
  Effect.tryPromise({ try: run, catch: () => undefined });
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
const instant = (epochMs: number): string => DateTime.formatIso(DateTime.makeUnsafe(epochMs));
const json = (body: object, status = 200, headers?: HeadersInit): Response => {
  const responseHeaders = new Headers(headers);
  responseHeaders.set("cache-control", "no-store");
  return Response.json(body, { status, headers: responseHeaders });
};

const recoveryAlphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const recoverySymbolCount = 25;
const sampleRecoveryCode = (): string =>
  Array.from(
    crypto.getRandomValues(new Uint8Array(recoverySymbolCount)),
    (byte) => recoveryAlphabet[byte % recoveryAlphabet.length]
  )
    .join("")
    .match(/.{5}/gu)
    ?.join("-") ?? "";

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
    const code = Schema.decodeOption(BackupRecoveryCode)(sampleRecoveryCode());
    if (Option.isNone(code)) return unavailable();
    const codeDigest = yield* attempt(() => sha256(code.value));
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
          .bind(uuid(), session.user_id, session.id, usedAt),
      ])
    );
    if (rotated[0]?.meta.changes !== 1 || rotated[1]?.meta.changes !== 1) {
      return noSession();
    }
    return json({
      data: {
        status: "rotated",
        backupRecoveryCode: code.value,
        rotatedAt: instant(usedAt),
      },
      next: [],
    });
  });
