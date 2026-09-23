import { type CatalogOperation, decideOperationAccess } from "@fidy/server/canonical-runtime";
import { Option, Schema } from "effect";
import {
  PATRow,
  currentMillis,
  digest,
  equalsDigest,
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
type CategoryAuthorization =
  | "accepted"
  | "unauthenticated"
  | "scope_missing"
  | "user_action_required";
const consentRevoked = async (db: D1Database, userId: string): Promise<boolean> =>
  (await db
    .prepare("SELECT 1 FROM consent_user_revocations WHERE user_id = ?")
    .bind(userId)
    .first()) !== null;
export type AuthorizedPAT = Readonly<{ patId: string; userId: string; digest: Uint8Array }>;
const scopeDecision = (
  scopes: ReturnType<typeof scopesFrom>,
  operation: CatalogOperation
): CategoryAuthorization => {
  if (Option.isNone(scopes)) return "unauthenticated";
  const access = decideOperationAccess(operation.policy.access, {
    _tag: "PAT",
    capabilities: scopes.value,
  });
  if (access._tag === "Allowed") return "accepted";
  return access.reason === "pat_scope_missing" ? "scope_missing" : "unauthenticated";
};
/** Every declared operation uses the same bearer, subject, expiry and policy decision. */
export const authorizeCanonicalPAT = async (
  request: Request,
  db: D1Database,
  operation: CatalogOperation
): Promise<AuthorizedPAT | Exclude<CategoryAuthorization, "accepted">> => {
  const pat = await authenticate(request, db);
  if (Option.isNone(pat)) return "unauthenticated";
  if (await consentRevoked(db, pat.value.user_id)) return "user_action_required";
  const decision = scopeDecision(scopesFrom(pat.value.scopes_json), operation);
  return decision === "accepted"
    ? {
        patId: pat.value.id,
        userId: pat.value.user_id,
        digest: new Uint8Array(pat.value.bearer_digest),
      }
    : decision;
};
