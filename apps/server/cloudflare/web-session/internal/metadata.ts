import { type AuthenticatedWebSession, type BoundWebSessionLookup } from "../contract";
import { Clock, DateTime, Effect, Option } from "effect";
import { prepareSelectedCurrentUser } from "../../../src/shell/identity/operations";
import type { CurrentUserMetadata } from "../../../src/shell/identity/contract";
import { decodeCategoryRead, prepareCategoryRead } from "../../../src/shell/categories/operations";
import { webSessionCredentialAuthority } from "../../../src/shell/web-session/operations";
import { webSessionIdleRenewalCandidate } from "../../../src/core/web-session/operations";

import { attempt, uuid } from "./support";

type Input = Readonly<{ db: D1Database; subject: AuthenticatedWebSession }>;
/** The same prepared observation also serves callers that already resolved their exact subject. */
export const readMetadata = (
  input: Input
): Effect.Effect<Option.Option<typeof CurrentUserMetadata.Type>, void> =>
  Effect.gen(function* () {
    const current = yield* Clock.currentTimeMillis;
    const authority = webSessionCredentialAuthority({ subject: input.subject, current });
    const prepared = prepareBrowserMetadata({
      db: input.db,
      current,
      lookup: {
        authority,
        digest: input.subject.digest,
        statement: {
          sql: `SELECT id,user_id AS userId FROM ${authority.table} WHERE ${authority.predicate}`,
          params: authority.bindings,
        },
      },
    });
    const rows = yield* attempt(() => input.db.batch([...prepared.statements])).pipe(
      Effect.uninterruptible
    );
    return yield* prepared.decode(rows);
  });

/** Prepare the same metadata observation before resolving the exact cookie's User. */
export const prepareBrowserMetadata = ({
  db,
  lookup,
  current,
}: Readonly<{
  db: D1Database;
  lookup: BoundWebSessionLookup;
  current: number;
}>): Readonly<{
  statements: ReadonlyArray<D1PreparedStatement>;
  decode: (
    rows: ReadonlyArray<D1Result>
  ) => Effect.Effect<Option.Option<typeof CurrentUserMetadata.Type>, void>;
}> => {
  const prepared = prepareSelectedCurrentUser(lookup.statement);
  const authority = lookup.authority;
  const candidate = DateTime.toEpochMillis(
    webSessionIdleRenewalCandidate(DateTime.makeUnsafe(current))
  );
  return {
    statements: [
      db
        .prepare(
          `UPDATE web_sessions SET idle_expires_at_ms = min(hard_expires_at_ms, max(idle_expires_at_ms, ?)) WHERE ${authority.predicate}`
        )
        .bind(candidate, ...authority.bindings),
      db.prepare(prepared.statement.sql).bind(...prepared.statement.params),
      prepareCategoryRead({ db, authority: Option.none() }),
      db
        .prepare(`INSERT INTO audit_entries(record_type,id,user_id,session_id,occurred_at_ms)
        SELECT 'identity_read',?,caller.userId,caller.id,? FROM (${lookup.statement.sql}) caller
        WHERE EXISTS (${prepared.statement.sql})`)
        .bind(uuid(), current, ...lookup.statement.params, ...prepared.statement.params),
    ],
    decode: (
      rows: ReadonlyArray<D1Result>
    ): Effect.Effect<Option.Option<typeof CurrentUserMetadata.Type>, void> =>
      Effect.gen(function* () {
        if (rows[0]?.meta.changes !== 1 || rows[3]?.meta.changes !== 1) return Option.none();
        const loaded = yield* prepared
          .decode(rows[1]?.results ?? [])
          .pipe(Effect.mapError(() => undefined));
        return Option.map(decodeCategoryRead(rows[2]?.results), (categories) => ({
          ...loaded,
          categories: Option.some(categories.data),
        }));
      }),
  };
};
