import {
  patRevokeAllCompletion,
  preparePATMetadata,
  revocablePATGrants,
  revocablePairingGrants,
  revokeEveryPAT,
  revokeEveryPairing,
  revokeOnePAT,
} from "../../../src/shell/tokens/operations";
import {
  recordAllPATRevocations,
  recordOnePATRevocation,
  recordPATList,
  refusedByAuditBudget,
} from "../../../src/shell/audit/operations";
import { ActivePATList } from "../../../src/core/tokens/contract";
import { type Cause, Clock, Effect, Option, Schema } from "effect";
import { freshSessionParams } from "../../../src/shell/web-session/operations";
import {
  revokeAllPATConsents,
  revokeAllPairingConsents,
  revokeOnePATConsent,
} from "../../../src/shell/consent/operations";
import {
  type SessionRow,
  canonical,
  httpRateLimited,
  notFound,
  response,
  sessionExists,
  shortIdIsValid,
  unauthorized,
  serviceUnavailable as unavailable,
  webSession,
} from "./pat-shared";
import { newId } from "../../secret-material/operations";
import { commitPATUnit } from "./pat-unit";
import { authenticateCanonicalWebSession } from "../../web-session/operations";
import { liveWebSessionAuthority } from "../../../src/shell/identity/operations";
import type { PATMetadataQuery } from "../contract";

export { createManualPAT } from "./pat-manual";

/** Decode the browser transport only; listing below owns the live proof, snapshot and Audit. */
export const listPATs = (
  input: Readonly<{ request: Request; db: D1Database }>
): Effect.Effect<Response, Cause.UnknownError> =>
  Effect.gen(function* () {
    const current = yield* Clock.currentTimeMillis;
    const subject = yield* Effect.tryPromise(() =>
      authenticateCanonicalWebSession({ ...input, current })
    );
    if (Option.isNone(subject)) return unauthorized();
    return yield* listPATsForCaller({ db: input.db, subject: subject.value });
  });

/** List only active, same-User safe metadata while rechecking the exact caller proof in D1. */
export const listPATsForCaller = ({ db, subject }: PATMetadataQuery): Effect.Effect<Response> =>
  Effect.gen(function* () {
    if ("patId" in subject) return unauthorized();
    const current = yield* Clock.currentTimeMillis;
    const authority = liveWebSessionAuthority({ subject, current });
    const session = { id: subject.id, user_id: subject.userId };
    const metadata = preparePATMetadata({ userId: subject.userId, current, authority });
    return yield* Effect.gen(function* () {
      const [rows, recorded] = yield* Effect.tryPromise({
        try: () =>
          db.batch(
            [
              metadata.statement,

              recordPATList({
                session,
                authority,
                input: { id: newId(), current },
              }),
            ].map(({ sql, params }) => db.prepare(sql).bind(...params))
          ),
        catch: (error) =>
          refusedByAuditBudget(error) ? ("rate_limited" as const) : ("unavailable" as const),
      });
      if (recorded?.meta.changes !== 1) return unauthorized();
      if (rows === undefined) return unavailable();
      const listed = yield* metadata.decode(rows.results).pipe(Effect.option);
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
  });

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
}: Readonly<{ request: Request; db: D1Database; shortId: string }>): Effect.Effect<
  Response,
  Cause.UnknownError
> =>
  Effect.gen(function* () {
    const session = yield* webSession({ request, db, fresh: true });
    if (Option.isNone(session)) return unauthorized();
    if (!shortIdIsValid(shortId)) return notFound();
    const current = yield* Clock.currentTimeMillis;
    return yield* Effect.tryPromise(() =>
      commitPATUnit({
        db,
        statements: [
          revokeOnePATConsent({
            session: session.value,
            input: { id: newId(), shortId, current },
            candidates: revocablePATGrants({
              userId: session.value.user_id,
              shortId: Option.some(shortId),
              current,
            }),
          }),

          revokeOnePAT({ session: session.value, input: { shortId, current } }),

          recordOnePATRevocation({
            session: session.value,
            input: { id: newId(), shortId, current },
          }),
        ].map(({ sql, params }) => db.prepare(sql).bind(...params)),
      })
    ).pipe(
      Effect.map(() => canonical({ shortId })),
      Effect.catch(() => revokedPATResponse(db, session.value, { shortId, current }))
    );
  });

/** Revoke all active grants and close every unclaimed approval under one WebSession check. */
export const revokeAllPATs = ({
  request,
  db,
}: Readonly<{ request: Request; db: D1Database }>): Effect.Effect<Response, Cause.UnknownError> =>
  Effect.gen(function* () {
    const session = yield* webSession({ request, db, fresh: true });
    if (Option.isNone(session)) return unauthorized();
    const current = yield* Clock.currentTimeMillis;
    const committed = yield* Effect.tryPromise(() => {
      const auditStatement = revokeAllPATConsents({
        session: session.value,
        current,
        candidates: revocablePATGrants({
          userId: session.value.user_id,
          current,
          shortId: Option.none(),
        }),
      });
      const auditStatement2 = revokeEveryPAT({ session: session.value, current });
      const auditStatement3 = revokeAllPairingConsents({
        session: session.value,
        current,
        candidates: revocablePairingGrants(session.value.user_id),
      });
      const auditStatement4 = revokeEveryPairing({ session: session.value, current });
      const auditStatement5 = recordAllPATRevocations({
        session: session.value,
        input: { id: newId(), current },
      });
      return commitPATUnit({
        db,
        statements: [
          db.prepare(auditStatement.sql).bind(...auditStatement.params),
          db.prepare(auditStatement2.sql).bind(...auditStatement2.params),
          db.prepare(auditStatement3.sql).bind(...auditStatement3.params),
          db.prepare(auditStatement4.sql).bind(...auditStatement4.params),
          db
            .prepare(patRevokeAllCompletion)
            .bind(session.value.user_id, current, session.value.user_id),
          db.prepare(auditStatement5.sql).bind(...auditStatement5.params),
        ],
      });
    });
    if (committed[5]?.meta.changes !== 1) return unauthorized();
    return canonical({ revokedCount: committed[1]?.meta.changes ?? 0 });
  });
