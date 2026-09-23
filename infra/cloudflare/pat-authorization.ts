import {
  type CatalogOperation,
  decideOperationAccess,
  patScopeCapability,
} from "@fidy/server/canonical-runtime";
import type { CanonicalCapability } from "@fidy/server/canonical-runtime";
import { type Cause, Effect, Option, Schema } from "effect";
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
const authenticate = (
  request: Request,
  db: D1Database
): Effect.Effect<Option.Option<typeof StoredPAT.Type>, Cause.UnknownError> =>
  Effect.gen(function* () {
    const authorization = request.headers.get("authorization") ?? "";
    if (!authorization.startsWith("Bearer ")) return Option.none();
    const bearer = authorization.slice("Bearer ".length);
    if (!validBearer(bearer)) return Option.none();
    const shortId = bearer.slice("fin_".length, "fin_".length + shortLength);
    const raw = yield* Effect.tryPromise(() =>
      db
        .prepare(`SELECT id,user_id,short_id,recipient_label,scopes_json,lifetime_days,
    created_at_ms,expires_at_ms,last_used_at_ms,revoked_at_ms,bearer_digest FROM pats WHERE short_id = ?`)
        .bind(shortId)
        .first()
    );
    const pat = Schema.decodeUnknownOption(StoredPAT)(raw);
    if (Option.isNone(pat)) return Option.none();
    if (pat.value.revoked_at_ms !== null || pat.value.expires_at_ms <= currentMillis()) {
      return Option.none();
    }
    const candidate = yield* Effect.tryPromise(() => digest(bearer));
    return equalsDigest({ stored: pat.value.bearer_digest, candidate }) ? pat : Option.none();
  });
type CategoryAuthorization =
  | "accepted"
  | "unauthenticated"
  | "scope_missing"
  | "user_action_required";
const consentRevoked = (
  db: D1Database,
  userId: string
): Effect.Effect<boolean, Cause.UnknownError> =>
  Effect.tryPromise(() =>
    db.prepare("SELECT 1 FROM consent_user_revocations WHERE user_id = ?").bind(userId).first()
  ).pipe(Effect.map((row) => row !== null));
export type AuthorizedPAT = Readonly<{
  patId: string;
  userId: string;
  digest: Uint8Array;
  requiredScope: Option.Option<CanonicalCapability>;
}>;
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
export const authorizeCanonicalPAT = ({
  request,
  db,
  operation,
}: Readonly<{ request: Request; db: D1Database; operation: CatalogOperation }>): Promise<
  AuthorizedPAT | Exclude<CategoryAuthorization, "accepted">
> =>
  Effect.runPromise(
    Effect.gen(function* () {
      const pat = yield* authenticate(request, db);
      if (Option.isNone(pat)) return "unauthenticated";
      if (yield* consentRevoked(db, pat.value.user_id)) return "user_action_required";
      const decision = scopeDecision(scopesFrom(pat.value.scopes_json), operation);
      return decision === "accepted"
        ? {
            patId: pat.value.id,
            userId: pat.value.user_id,
            digest: new Uint8Array(pat.value.bearer_digest),
            requiredScope: patScopeCapability(operation.policy.access),
          }
        : decision;
    })
  );
