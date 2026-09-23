import {
  CategoriesGroup,
  decideOperationAccess,
  getOperationPolicy,
} from "@fidy/server/categories";
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
  if (pat.value.revoked_at_ms !== null || pat.value.expires_at_ms <= currentMillis()) {
    return Option.none();
  }
  return equalsDigest(pat.value.bearer_digest, await digest(bearer)) ? pat : Option.none();
};
type CategoryAuthorization = "accepted" | "unauthenticated" | "scope_missing";
const categoryOperation = CategoriesGroup.endpoints.listCategories;
const categoryOperationId = `${CategoriesGroup.identifier}.${categoryOperation.identifier}`;
const categoryScopeDecision = (scopes: ReturnType<typeof scopesFrom>): CategoryAuthorization => {
  if (Option.isNone(scopes)) return "unauthenticated";
  const access = decideOperationAccess(getOperationPolicy(categoryOperation).access, {
    _tag: "PAT",
    capabilities: scopes.value,
  });
  if (access._tag === "Allowed") return "accepted";
  return access.reason === "pat_scope_missing" ? "scope_missing" : "unauthenticated";
};
/** Verify bearer bytes and declared operation policy, revocation and expiry at D1. */
export const authorizeCategoryPAT = async (
  request: Request,
  db: D1Database
): Promise<CategoryAuthorization> => {
  const pat = await authenticate(request, db);
  if (Option.isNone(pat)) return "unauthenticated";
  const decision = categoryScopeDecision(scopesFrom(pat.value.scopes_json));
  if (decision !== "accepted") return decision;
  const current = currentMillis();
  const result = await db.batch([
    db
      .prepare(
        `UPDATE pats SET last_used_at_ms = ? WHERE id = ? AND revoked_at_ms IS NULL AND expires_at_ms > ?`
      )
      .bind(current, pat.value.id, current),
    db
      .prepare(`INSERT INTO pat_audit (id,user_id,pat_id,operation,outcome,occurred_at_ms)
      SELECT ?,?,?, ?, 'accepted', ? WHERE changes() = 1`)
      .bind(newId(), pat.value.user_id, pat.value.id, categoryOperationId, current),
  ]);
  return result[0]?.meta.changes === 1 && result[1]?.meta.changes === 1
    ? "accepted"
    : "unauthenticated";
};
