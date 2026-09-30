import { freshSessionExists } from "@fidy/server/web-session";
import type { FreshSessionSubject } from "@fidy/server/web-session";
import { browserSession } from "@fidy/server/web-session-runtime";
import {
  patRevokeAllCompletion,
  recordAllPATRevocations,
  recordOnePATRevocation,
  revokeEveryPAT,
  revokeEveryPairing,
  revokeOnePAT,
} from "@fidy/server/tokens-operations";
import { type Cause, Effect, Option, Schema } from "effect";
import { freshSessionParams } from "@fidy/server/web-session";
import {
  revokeAllPATConsents,
  revokeAllPairingConsents,
  revokeOnePATConsent,
} from "@fidy/server/consent-pat";
import {
  canonical,
  currentMillis,
  newId,
  notFound,
  shortIdIsValid,
  unauthorized,
  serviceUnavailable as unavailable,
} from "./pat-shared";
import { commitPATUnit } from "./pat-unit";
import { prepareOwnedStatement } from "../../atomic/operations";

export { createManualPAT } from "./pat-manual";

const revokedPATResponse = (
  db: D1Database,
  session: FreshSessionSubject,
  input: Readonly<{ shortId: string; current: number }>
): Effect.Effect<Response, Cause.UnknownError> =>
  Effect.gen(function* () {
    const { shortId, current } = input;
    const owned = yield* Effect.tryPromise(() =>
      db
        .prepare(
          `SELECT revoked_at_ms FROM pats WHERE user_id = ? AND short_id = ? AND ${freshSessionExists}`
        )
        .bind(session.userId, shortId, ...freshSessionParams({ session, time: current }))
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
      const session = yield* Effect.tryPromise(() =>
        browserSession({ request, db, input: { current: currentMillis(), fresh: true } })
      );
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
      const session = yield* Effect.tryPromise(() =>
        browserSession({ request, db, input: { current: currentMillis(), fresh: true } })
      );
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
              .bind(session.value.userId, current, session.value.userId),
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
