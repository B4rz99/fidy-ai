import { ActivePATMetadata } from "@fidy/server/tokens-runtime";
import { DateTime, Option, Schema } from "effect";
import {
  PATRow,
  canonical,
  currentMillis,
  newId,
  notFound,
  scopesFrom,
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
  const rows = await db
    .prepare(`SELECT id,user_id,short_id,recipient_label,scopes_json,lifetime_days,
    created_at_ms,expires_at_ms,last_used_at_ms,revoked_at_ms FROM pats WHERE user_id = ?
    AND revoked_at_ms IS NULL AND expires_at_ms > ? ORDER BY created_at_ms DESC LIMIT 100`)
    .bind(session.value.user_id, currentMillis())
    .all();
  const pats: Array<unknown> = [];
  for (const value of rows.results) {
    const row = Schema.decodeUnknownOption(PATRow)(value);
    if (Option.isNone(row)) return unavailable();
    const scopes = scopesFrom(row.value.scopes_json);
    if (Option.isNone(scopes)) return unavailable();
    const metadata = Schema.decodeUnknownOption(Schema.toType(ActivePATMetadata))({
      shortId: row.value.short_id,
      recipientLabel: row.value.recipient_label,
      scopes: scopes.value,
      createdAt: DateTime.makeUnsafe(row.value.created_at_ms),
      lastUsedAt: Option.map(Option.fromNullishOr(row.value.last_used_at_ms), DateTime.makeUnsafe),
      expiresAt: DateTime.makeUnsafe(row.value.expires_at_ms),
    });
    if (Option.isNone(metadata)) return unavailable();
    pats.push(Schema.encodeSync(Schema.toCodecJson(ActivePATMetadata))(metadata.value));
  }
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
  return recorded.meta.changes === 1 ? canonical({ pats }) : unauthorized();
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
    db
      .prepare(`UPDATE pats SET revoked_at_ms = ? WHERE user_id = ? AND short_id = ? AND revoked_at_ms IS NULL
      AND ${sessionExists}`)
      .bind(current, session.value.user_id, shortId, ...sessionParams(session.value, current)),
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
  if (updated[0]?.meta.changes !== 1) {
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
    db
      .prepare(`UPDATE pats SET revoked_at_ms = ? WHERE user_id = ? AND revoked_at_ms IS NULL
      AND expires_at_ms > ? AND ${sessionExists}`)
      .bind(current, session.value.user_id, current, ...sessionParams(session.value, current)),
    db
      .prepare(`UPDATE pat_pairings SET state = 'revoked_unclaimed' WHERE user_id = ?
      AND state = 'approved_awaiting_claim' AND ${sessionExists}`)
      .bind(session.value.user_id, ...sessionParams(session.value, current)),
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
  if (committed[2]?.meta.changes !== 1) return unauthorized();
  return canonical({ revokedCount: committed[0]?.meta.changes ?? 0 });
};
