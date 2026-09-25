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
import { type Cause, Effect, Option, Schema } from "effect";
import { freshSessionParams } from "@fidy/server/identity-runtime";
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
  shortIdIsValid,
  unauthorized,
  serviceUnavailable as unavailable,
  webSession,
} from "./pat-shared";
import { commitPATUnit, prepareOwnedStatement } from "./pat-unit";
import { refusedByAuditBudget } from "../audit/audit-triggers";

export { createManualPAT } from "./pat-manual";

/** List only currently active, subject-owned, safe PAT metadata. */
export const listPATs = ({
  request,
  db,
}: Readonly<{ request: Request; db: D1Database }>): Promise<Response> =>
  Effect.runPromise(
    Effect.gen(function* () {
      const session = yield* Effect.tryPromise(() => webSession({ request, db, fresh: false }));
      if (Option.isNone(session)) return unauthorized();
      const current = currentMillis();
      return yield* Effect.gen(function* () {
        const [rows, recorded] = yield* Effect.tryPromise({
          try: () =>
            db.batch([
              prepareOwnedStatement({
                db,
                statement: patMetadataQuery({ userId: session.value.user_id, current, session }),
              }),
              prepareOwnedStatement({
                db,
                statement: recordPATList({
                  session: session.value,
                  input: { id: newId(), current },
                }),
              }),
            ]),
          catch: (error) =>
            refusedByAuditBudget(error) ? ("rate_limited" as const) : ("unavailable" as const),
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
              ? response({
                  body: {
                    error: { code: "rate_limited", message: "PAT metadata budget exhausted." },
                    next: [],
                  },
                  status: httpRateLimited,
                })
              : unavailable()
          )
        )
      );
    })
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
        .bind(session.user_id, shortId, ...freshSessionParams({ session, time: current }))
        .first()
    );
    const record = Schema.decodeUnknownOption(
      Schema.Struct({ revoked_at_ms: Schema.NullOr(Schema.Finite) })
    )(owned);
    if (Option.isNone(record)) return notFound();
    return record.value.revoked_at_ms === null ? unavailable() : canonical({ shortId });
  });

/** Idempotently revoke one owned PAT; foreign and unknown ids are indistinguishable. */
export const revokePAT = ({
  request,
  db,
  shortId,
}: Readonly<{ request: Request; db: D1Database; shortId: string }>): Promise<Response> =>
  Effect.runPromise(
    Effect.gen(function* () {
      const session = yield* Effect.tryPromise(() => webSession({ request, db, fresh: true }));
      if (Option.isNone(session)) return unauthorized();
      if (!shortIdIsValid(shortId)) return notFound();
      const current = currentMillis();
      return yield* Effect.tryPromise(() =>
        commitPATUnit({
          db,
          statements: [
            prepareOwnedStatement({
              db,
              statement: revokeOnePATConsent({
                session: session.value,
                input: { id: newId(), shortId, current },
              }),
            }),
            prepareOwnedStatement({
              db,
              statement: revokeOnePAT({ session: session.value, input: { shortId, current } }),
            }),
            prepareOwnedStatement({
              db,
              statement: recordOnePATRevocation({
                session: session.value,
                input: { id: newId(), shortId, current },
              }),
            }),
          ],
        })
      ).pipe(
        Effect.map(() => canonical({ shortId })),
        Effect.catch(() => revokedPATResponse(db, session.value, { shortId, current }))
      );
    })
  );

/** Revoke all active grants and close every unclaimed approval under one WebSession check. */
export const revokeAllPATs = ({
  request,
  db,
}: Readonly<{ request: Request; db: D1Database }>): Promise<Response> =>
  Effect.runPromise(
    Effect.gen(function* () {
      const session = yield* Effect.tryPromise(() => webSession({ request, db, fresh: true }));
      if (Option.isNone(session)) return unauthorized();
      const current = currentMillis();
      const committed = yield* Effect.tryPromise(() =>
        commitPATUnit({
          db,
          statements: [
            prepareOwnedStatement({
              db,
              statement: revokeAllPATConsents({ session: session.value, current }),
            }),
            prepareOwnedStatement({
              db,
              statement: revokeEveryPAT({ session: session.value, current }),
            }),
            prepareOwnedStatement({
              db,
              statement: revokeAllPairingConsents({ session: session.value, current }),
            }),
            prepareOwnedStatement({
              db,
              statement: revokeEveryPairing({ session: session.value, current }),
            }),
            db
              .prepare(patRevokeAllCompletion)
              .bind(session.value.user_id, current, session.value.user_id),
            prepareOwnedStatement({
              db,
              statement: recordAllPATRevocations({
                session: session.value,
                input: { id: newId(), current },
              }),
            }),
          ],
        })
      );
      if (committed[5]?.meta.changes !== 1) return unauthorized();
      return canonical({ revokedCount: committed[1]?.meta.changes ?? 0 });
    })
  );
