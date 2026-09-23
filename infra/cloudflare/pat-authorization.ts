import { Option, Schema } from "effect";
import {
  PATRow,
  currentMillis,
  digest,
  equalsDigest,
  newId,
  scopesFrom,
  shortLength,
  validBearer,
} from "./pat-shared";

const StoredPAT = Schema.Struct({ ...PATRow.fields, bearer_digest: Schema.Array(Schema.Int) });
const authenticate = async (
  request: Request,
  db: D1Database
): Promise<Option.Option<typeof StoredPAT.Type>> => {
  const authorization = request.headers.get("authorization") ?? "";
  if (!authorization.startsWith("Bearer ")) return Option.none();
  const bearer = authorization.slice("Bearer ".length);
  if (!validBearer(bearer)) return Option.none();
  const shortId = bearer.slice("fin_".length, "fin_".length + shortLength);
  const raw = await db
    .prepare(`SELECT id,user_id,short_id,recipient_label,scopes_json,lifetime_days,
    created_at_ms,expires_at_ms,last_used_at_ms,revoked_at_ms,bearer_digest FROM pats WHERE short_id = ?`)
    .bind(shortId)
    .first();
  const pat = Schema.decodeUnknownOption(StoredPAT)(raw);
  if (Option.isNone(pat)) return Option.none();
  return equalsDigest(pat.value.bearer_digest, await digest(bearer)) ? pat : Option.none();
};
/** Verify bearer bytes, scope, revocation and absolute expiry at the authoritative D1 boundary. */
export const authorizeCategoryPAT = async (request: Request, db: D1Database): Promise<boolean> => {
  const pat = await authenticate(request, db);
  if (Option.isNone(pat)) return false;
  const scopes = scopesFrom(pat.value.scopes_json);
  if (Option.isNone(scopes) || !scopes.value.includes("read")) return false;
  const current = currentMillis();
  const result = await db.batch([
    db
      .prepare(
        `UPDATE pats SET last_used_at_ms = ? WHERE id = ? AND revoked_at_ms IS NULL AND expires_at_ms > ?`
      )
      .bind(current, pat.value.id, current),
    db
      .prepare(`INSERT INTO pat_audit (id,user_id,pat_id,operation,outcome,occurred_at_ms)
      SELECT ?,?,?, 'categories.listCategories', 'accepted', ? WHERE changes() = 1`)
      .bind(newId(), pat.value.user_id, pat.value.id, current),
  ]);
  return result[0]?.meta.changes === 1 && result[1]?.meta.changes === 1;
};
