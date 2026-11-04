import { Effect, Option, Schema } from "effect";
import { userOwnedAgentCapability } from "../../../src/shell/canonical-policy/contract";
import { PATUnavailable } from "../contract";
import { patBearerPrefix } from "../../../src/core/tokens/contract";
import { prepareConsentStatus } from "../../consent/operations";
import type { AuthorizedPAT, CanonicalPATMaterial, CanonicalPATSnapshot } from "../contract";
import { PATRow, digest, equalsDigest, scopesFrom, shortLength, validBearer } from "./pat-shared";

const StoredPAT = Schema.Struct({ ...PATRow.fields, bearer_digest: Schema.Array(Schema.Int) });
/** Hash before entering SQL; no lookup or retained User selection happens here. */
export const prepareMaterial = (
  request: Request
): Effect.Effect<Option.Option<CanonicalPATMaterial>, PATUnavailable> =>
  Effect.gen(function* () {
    const authorization = request.headers.get("authorization") ?? "";
    if (!authorization.startsWith("Bearer ")) return Option.none();
    const bearer = authorization.slice("Bearer ".length);
    if (!validBearer(bearer)) return Option.none();
    const candidate = yield* Effect.tryPromise({
      try: () => digest(bearer),
      catch: () => new PATUnavailable(),
    });
    return Option.some({
      shortId: bearer.slice(patBearerPrefix.length, patBearerPrefix.length + shortLength),
      digest: candidate,
    });
  });

const liveMaterial = (
  pat: typeof StoredPAT.Type,
  material: CanonicalPATMaterial,
  current: number
): boolean =>
  pat.revoked_at_ms === null &&
  pat.expires_at_ms > current &&
  equalsDigest({ stored: pat.bearer_digest, candidate: material.digest }) &&
  Option.isSome(scopesFrom(pat.scopes_json));

/** This subject is unresolved until canonical admission and owner publication recheck live authority. */
export const resolveSnapshot = ({
  db,
  material,
  current,
  execute,
  operation,
}: CanonicalPATSnapshot): AuthorizedPAT | "unauthenticated" | "user_action_required" => {
  const rows = execute([
    db
      .prepare(`SELECT id,user_id,short_id,recipient_label,scopes_json,lifetime_days,
    created_at_ms,expires_at_ms,last_used_at_ms,revoked_at_ms,bearer_digest FROM pats WHERE short_id = ?`)
      .bind(material.shortId),
  ]);
  const pat = Schema.decodeUnknownOption(StoredPAT)(rows[0]?.results[0]);
  if (Option.isNone(pat) || !liveMaterial(pat.value, material, current)) {
    return "unauthenticated";
  }
  const consent = prepareConsentStatus({ db, userId: pat.value.user_id });
  const status = Option.getOrThrow(consent.decode(execute([consent.statement])[0]?.results[0]));
  if (status === "Revoked") return "user_action_required";
  return {
    patId: pat.value.id,
    userId: pat.value.user_id,
    digest: material.digest,
    requiredScope: userOwnedAgentCapability(operation.policy.access),
  };
};
