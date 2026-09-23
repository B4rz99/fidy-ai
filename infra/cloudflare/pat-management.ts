import {
  ActivePATList,
  patMetadataQuery,
  patMetadataResponseFromRows,
  patRevokeAllCompletion,
  recordAllPATRevocations,
  recordOnePATRevocation,
  recordPATList,
  revokeEveryPAT,
  revokeEveryPairing,
  revokeOnePAT,
} from "@fidy/server/tokens-runtime";
import { type Cause, Effect, Function, Option, Schema } from "effect";
import {
  revokeAllPATConsents,
  revokeAllPairingConsents,
  revokeOnePATConsent,
} from "@fidy/server/consent-pat";
import {
  type SessionRow,
  canonical,
  currentMillis,
  httpRateLimited,
  newId,
  notFound,
  response,
  sessionExists,
  sessionParams,
  shortIdIsValid,
  unauthorized,
  serviceUnavailable as unavailable,
  webSession,
} from "./pat-shared";
import { commitPATUnit, prepareOwnedStatement } from "./pat-unit";

export { createManualPAT } from "./pat-manual";

/** List only currently active, subject-owned, safe PAT metadata. */
export const listPATs = Function.dual<
  (db: D1Database) => (request: Request) => Promise<Response>,
  (request: Request, db: D1Database) => Promise<Response>
>(2, (request, db) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const session = yield* Effect.tryPromise(() => webSession(request, db, false));
      if (Option.isNone(session)) return unauthorized();
      const current = currentMillis();
      return yield* Effect.gen(function* () {
        const [rows, recorded] = yield* Effect.tryPromise({
          try: () =>
            db.batch([
              prepareOwnedStatement(db, patMetadataQuery(session.value.user_id, current, session)),
              prepareOwnedStatement(db, recordPATList(session.value, { id: newId(), current })),
            ]),
          catch: (error) =>
            String(error).includes("transaction_audit_limit")
              ? ("rate_limited" as const)
              : ("unavailable" as const),
        });
        if (recorded?.meta.changes !== 1) return unauthorized();
        if (rows === undefined) return unavailable();
        const listed = yield* patMetadataResponseFromRows(rows.results).pipe(Effect.option);
        return Option.isSome(listed)
          ? canonical(
              yield* Schema.encodeEffect(Schema.toCodecJson(ActivePATList))(listed.value.data)
            )
          : unavailable();
      }).pipe(
        Effect.catch((error) =>
          Effect.succeed(
            error === "rate_limited"
              ? response(
                  {
                    error: { code: "rate_limited", message: "PAT metadata budget exhausted." },
                    next: [],
                  },
                  httpRateLimited
                )
              : unavailable()
          )
        )
      );
    })
  )
);

const revokedPATResponse = (
  db: D1Database,
  session: SessionRow,
  input: Readonly<{ shortId: string; current: number }>
): Effect.Effect<Response, Cause.UnknownError> =>
  Effect.gen(function* () {
    const { shortId, current } = input;
    const owned = yield* Effect.tryPromise(() =>
      db
        .prepare(
          `SELECT revoked_at_ms FROM pats WHERE user_id = ? AND short_id = ? AND ${sessionExists}`
        )
        .bind(session.user_id, shortId, ...sessionParams(session, current))
        .first()
    );
    const record = Schema.decodeUnknownOption(
      Schema.Struct({ revoked_at_ms: Schema.NullOr(Schema.Finite) })
    )(owned);
    if (Option.isNone(record)) return notFound();
    return record.value.revoked_at_ms === null ? unavailable() : canonical({ shortId });
  });

/** Idempotently revoke one owned PAT; foreign and unknown ids are indistinguishable. */
export const revokePAT = Function.dual<
  (db: D1Database, shortId: string) => (request: Request) => Promise<Response>,
  (request: Request, db: D1Database, shortId: string) => Promise<Response>
>(3, (request, db, shortId) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const session = yield* Effect.tryPromise(() => webSession(request, db, true));
      if (Option.isNone(session)) return unauthorized();
      if (!shortIdIsValid(shortId)) return notFound();
      const current = currentMillis();
      return yield* Effect.tryPromise(() =>
        commitPATUnit(db, [
          prepareOwnedStatement(
            db,
            revokeOnePATConsent(session.value, { id: newId(), shortId, current })
          ),
          prepareOwnedStatement(db, revokeOnePAT(session.value, { shortId, current })),
          prepareOwnedStatement(
            db,
            recordOnePATRevocation(session.value, { id: newId(), shortId, current })
          ),
        ])
      ).pipe(
        Effect.map(() => canonical({ shortId })),
        Effect.catch(() => revokedPATResponse(db, session.value, { shortId, current }))
      );
    })
  )
);

/** Revoke all active grants and close every unclaimed approval under one WebSession check. */
export const revokeAllPATs = Function.dual<
  (db: D1Database) => (request: Request) => Promise<Response>,
  (request: Request, db: D1Database) => Promise<Response>
>(2, (request, db) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const session = yield* Effect.tryPromise(() => webSession(request, db, true));
      if (Option.isNone(session)) return unauthorized();
      const current = currentMillis();
      const committed = yield* Effect.tryPromise(() =>
        commitPATUnit(db, [
          prepareOwnedStatement(db, revokeAllPATConsents(session.value, current)),
          prepareOwnedStatement(db, revokeEveryPAT(session.value, current)),
          prepareOwnedStatement(db, revokeAllPairingConsents(session.value, current)),
          prepareOwnedStatement(db, revokeEveryPairing(session.value, current)),
          db
            .prepare(patRevokeAllCompletion)
            .bind(session.value.user_id, current, session.value.user_id),
          prepareOwnedStatement(
            db,
            recordAllPATRevocations(session.value, { id: newId(), current })
          ),
        ])
      );
      if (committed[5]?.meta.changes !== 1) return unauthorized();
      return canonical({ revokedCount: committed[1]?.meta.changes ?? 0 });
    })
  )
);
