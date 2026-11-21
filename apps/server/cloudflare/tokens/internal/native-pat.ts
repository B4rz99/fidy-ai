import { type Cause, Effect, Option, Schema } from "effect";
import { SqliteClient } from "@effect/sql-sqlite-do/SqliteClient";
import { UserId } from "../../../src/core/identity/contract";
import {
  PATId,
  TokenBearer,
  patBearerPrefix,
  patShortIdLength,
} from "../../../src/core/tokens/contract";
import { livePATCredential } from "../../../src/shell/tokens/operations";
import { digest, scopesFrom } from "./pat-shared";

export const patRouteProof = (
  request: Request
): Option.Option<
  Readonly<{ shortId: string; digest: Effect.Effect<Uint8Array, Cause.UnknownError> }>
> => {
  const authorization = request.headers.get("authorization") ?? "";

  if (!authorization.startsWith("Bearer ")) return Option.none();
  const bearer = authorization.slice("Bearer ".length);

  if (!Schema.is(TokenBearer)(bearer)) return Option.none();

  return Option.some({
    shortId: bearer.slice(patBearerPrefix.length, patBearerPrefix.length + patShortIdLength),
    digest: Effect.tryPromise(() => digest(bearer)),
  });
};

const Credential = Schema.Struct({ userId: UserId, patId: PATId, scopes: Schema.String });

export const localPATCredential = Effect.fn(function* ({
  id,
  shortId,
  digest,
  current,
  owns,
}: Readonly<{
  id: string;
  shortId: string;
  digest: Uint8Array;
  current: number;
  owns: (user: string) => boolean;
}>) {
  const sql = yield* SqliteClient;

  const [row] = yield* sql`SELECT id AS patId,user_id AS userId,scopes_json AS scopes FROM pats
     WHERE id=${id} AND short_id=${shortId} AND bearer_digest=${digest} AND revoked_at_ms IS NULL AND expires_at_ms>${current}
     AND NOT EXISTS(SELECT 1 FROM erasure_requests WHERE user_id=pats.user_id)`;

  if (row === undefined) return "unauthenticated" as const;
  const credential = yield* Schema.decodeUnknownEffect(Credential)(row);

  if (!owns(credential.userId)) return "unauthenticated" as const;

  const authority = livePATCredential({
    subject: { ...credential, digest, requiredScope: Option.none() },
    current,
  });

  const live = yield* sql.unsafe(
    `SELECT 1 FROM pats WHERE ${authority.predicate}`,
    authority.bindings
  );

  if (live.length !== 1) return "consent_revoked" as const;
  const scopes = scopesFrom(credential.scopes);

  if (Option.isNone(scopes)) return "unauthenticated" as const;

  return {
    userId: credential.userId,
    patId: credential.patId,
    scopes: scopes.value,
    digest,
    shortId,
  };
});
