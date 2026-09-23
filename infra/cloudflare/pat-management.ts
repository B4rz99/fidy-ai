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
import { Effect, Option, Schema } from "effect";
import {
  revokeAllPATConsents,
  revokeAllPairingConsents,
  revokeOnePATConsent,
} from "@fidy/server/consent-pat";
import {
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
export const listPATs = async (request: Request, db: D1Database): Promise<Response> => {
  const session = await webSession(request, db, false);
  if (Option.isNone(session)) return unauthorized();
  const current = currentMillis();
  try {
    const [rows, recorded] = await db.batch([
      prepareOwnedStatement(db, patMetadataQuery(session.value.user_id, current, session)),
      prepareOwnedStatement(db, recordPATList(session.value, { id: newId(), current })),
    ]);
    if (recorded?.meta.changes !== 1) return unauthorized();
    if (rows === undefined) return unavailable();
    const listed = await Effect.runPromise(
      patMetadataResponseFromRows(rows.results).pipe(Effect.option)
    );
    return Option.isSome(listed)
      ? canonical(Schema.encodeSync(Schema.toCodecJson(ActivePATList))(listed.value.data))
      : unavailable();
  } catch (error) {
    return String(error).includes("transaction_audit_limit")
      ? response(
          { error: { code: "rate_limited", message: "PAT metadata budget exhausted." }, next: [] },
          httpRateLimited
        )
      : unavailable();
  }
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
  try {
    await commitPATUnit(db, [
      prepareOwnedStatement(
        db,
        revokeOnePATConsent(session.value, { id: newId(), shortId, current })
      ),
      prepareOwnedStatement(db, revokeOnePAT(session.value, { shortId, current })),
      prepareOwnedStatement(
        db,
        recordOnePATRevocation(session.value, { id: newId(), shortId, current })
      ),
    ]);
    return canonical({ shortId });
  } catch {
    const owned = await db
      .prepare(
        `SELECT revoked_at_ms FROM pats WHERE user_id = ? AND short_id = ? AND ${sessionExists}`
      )
      .bind(session.value.user_id, shortId, ...sessionParams(session.value, current))
      .first();
    const record = Schema.decodeUnknownOption(
      Schema.Struct({ revoked_at_ms: Schema.NullOr(Schema.Finite) })
    )(owned);
    if (Option.isNone(record)) return notFound();
    return record.value.revoked_at_ms === null ? unavailable() : canonical({ shortId });
  }
};

/** Revoke all active grants and close every unclaimed approval under one WebSession check. */
export const revokeAllPATs = async (request: Request, db: D1Database): Promise<Response> => {
  const session = await webSession(request, db, true);
  if (Option.isNone(session)) return unauthorized();
  const current = currentMillis();
  const committed = await commitPATUnit(db, [
    prepareOwnedStatement(db, revokeAllPATConsents(session.value, current)),
    prepareOwnedStatement(db, revokeEveryPAT(session.value, current)),
    prepareOwnedStatement(db, revokeAllPairingConsents(session.value, current)),
    prepareOwnedStatement(db, revokeEveryPairing(session.value, current)),
    db.prepare(patRevokeAllCompletion).bind(session.value.user_id, current, session.value.user_id),
    prepareOwnedStatement(db, recordAllPATRevocations(session.value, { id: newId(), current })),
  ]);
  if (committed[5]?.meta.changes !== 1) return unauthorized();
  return canonical({ revokedCount: committed[1]?.meta.changes ?? 0 });
};
