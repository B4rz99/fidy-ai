import * as D1Client from "@effect/sql-d1/D1Client";
import { UserId } from "@fidy/server/identity-runtime";
import { ActivePATList, listPATsResponse } from "@fidy/server/tokens-runtime";
import { Context, Effect, Layer, Option, Schema } from "effect";
import { SqlClient } from "effect/unstable/sql";
import {
  allPATRevocationEvidence,
  allPairingRevocationEvidence,
  onePATRevocationEvidence,
} from "./pat-consent";
import {
  canonical,
  currentMillis,
  newId,
  notFound,
  sessionExists,
  sessionParams,
  shortIdIsValid,
  unauthorized,
  serviceUnavailable as unavailable,
  webSession,
} from "./pat-shared";

export { createManualPAT } from "./pat-manual";

/** List only currently active, subject-owned, safe PAT metadata. */
export const listPATs = async (request: Request, db: D1Database): Promise<Response> => {
  const session = await webSession(request, db, false);
  if (Option.isNone(session)) return unauthorized();
  const userId = Schema.decodeUnknownOption(UserId)(session.value.user_id);
  if (Option.isNone(userId)) return unavailable();
  const listed = await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const clients = yield* Layer.build(D1Client.layer({ db }));
        return yield* listPATsResponse(userId.value).pipe(
          Effect.withTracerEnabled(false),
          Effect.provideService(SqlClient.SqlClient, Context.get(clients, SqlClient.SqlClient))
        );
      })
    ).pipe(Effect.option)
  );
  if (Option.isNone(listed)) return unavailable();
  const current = currentMillis();
  const recorded = await db
    .prepare(`INSERT INTO pat_audit (id,user_id,session_id,operation,outcome,occurred_at_ms)
    SELECT ?,?,?,'pats.listPATs','accepted',? WHERE EXISTS (SELECT 1 FROM web_sessions
    WHERE id = ? AND user_id = ? AND revoked_at_ms IS NULL AND idle_expires_at_ms > ? AND hard_expires_at_ms > ?)`)
    .bind(
      newId(),
      session.value.user_id,
      session.value.id,
      current,
      session.value.id,
      session.value.user_id,
      current,
      current
    )
    .run();
  return recorded.meta.changes === 1
    ? canonical(Schema.encodeSync(Schema.toCodecJson(ActivePATList))(listed.value.data))
    : unauthorized();
};

/** Idempotently revoke one owned PAT; foreign and unknown ids are indistinguishable. */
export const revokePAT = async (
  request: Request,
  db: D1Database,
  shortId: string
): Promise<Response> => {
  const session = await webSession(request, db, true);
  if (Option.isNone(session)) return unauthorized();
  if (!shortIdIsValid(shortId)) return notFound();
  const current = currentMillis();
  const updated = await db.batch([
    onePATRevocationEvidence(db, session.value, { shortId, current }),
    db
      .prepare(`UPDATE pats SET revoked_at_ms = ? WHERE user_id = ? AND short_id = ? AND revoked_at_ms IS NULL
      AND expires_at_ms > ? AND ${sessionExists} AND EXISTS (SELECT 1 FROM pat_revocation_consents r WHERE r.pat_id = pats.id
      AND r.session_id = ? AND r.occurred_at_ms = ?)`)
      .bind(
        current,
        session.value.user_id,
        shortId,
        current,
        ...sessionParams(session.value, current),
        session.value.id,
        current
      ),
    db
      .prepare(`INSERT INTO pat_audit (id,user_id,session_id,pat_id,operation,outcome,occurred_at_ms)
      SELECT ?,?,?,id,'pats.revokePAT','accepted',? FROM pats
      WHERE user_id = ? AND short_id = ? AND changes() = 1`)
      .bind(
        newId(),
        session.value.user_id,
        session.value.id,
        current,
        session.value.user_id,
        shortId
      ),
  ]);
  if (updated[1]?.meta.changes !== 1) {
    const owned = await db
      .prepare(
        `SELECT 1 FROM pats WHERE user_id = ? AND short_id = ? AND revoked_at_ms IS NOT NULL
        AND ${sessionExists}`
      )
      .bind(session.value.user_id, shortId, ...sessionParams(session.value, current))
      .first();
    if (owned === null) return notFound();
  }
  return canonical({ shortId });
};

/** Revoke all active grants and close every unclaimed approval under one WebSession check. */
export const revokeAllPATs = async (request: Request, db: D1Database): Promise<Response> => {
  const session = await webSession(request, db, true);
  if (Option.isNone(session)) return unauthorized();
  const current = currentMillis();
  const committed = await db.batch([
    allPATRevocationEvidence(db, session.value, current),
    db
      .prepare(`UPDATE pats SET revoked_at_ms = ? WHERE user_id = ? AND revoked_at_ms IS NULL
      AND expires_at_ms > ? AND ${sessionExists}
      AND EXISTS (SELECT 1 FROM pat_revocation_consents r WHERE r.pat_id = pats.id AND r.session_id = ?)`)
      .bind(
        current,
        session.value.user_id,
        current,
        ...sessionParams(session.value, current),
        session.value.id
      ),
    allPairingRevocationEvidence(db, session.value, current),
    db
      .prepare(`UPDATE pat_pairings SET state = 'revoked_unclaimed' WHERE user_id = ?
      AND state = 'approved_awaiting_claim' AND ${sessionExists}
      AND EXISTS (SELECT 1 FROM pat_revocation_consents r WHERE r.pairing_id = pat_pairings.id AND r.session_id = ?)`)
      .bind(session.value.user_id, ...sessionParams(session.value, current), session.value.id),
    db
      .prepare(`INSERT INTO pat_audit (id,user_id,session_id,operation,outcome,occurred_at_ms)
      SELECT ?,?,?,'pats.revokeAllPATs','accepted',? WHERE ${sessionExists}`)
      .bind(
        newId(),
        session.value.user_id,
        session.value.id,
        current,
        ...sessionParams(session.value, current)
      ),
  ]);
  if (committed[4]?.meta.changes !== 1) return unauthorized();
  return canonical({ revokedCount: committed[1]?.meta.changes ?? 0 });
};
