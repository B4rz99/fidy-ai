import { requiresErasureSuppression } from "../../connections/operations";
import { Clock, Effect } from "effect";
import type { OwnedStatement } from "../../../src/shell/owner-write/contract";
import {
  type ErasureScope,
  type ErasureStore,
  ErasureUnavailable,
} from "../../erasure-store/contract";

export const seal = (
  input: Readonly<{
    db: D1Database;
    scope: ErasureScope;
    stores: ReadonlyArray<ErasureStore>;
  }>
): Effect.Effect<void, ErasureUnavailable> =>
  Effect.gen(function* () {
    const blocked = yield* requiresErasureSuppression({
      db: input.db,
      userId: input.scope.userId,
    }).pipe(Effect.mapError(() => new ErasureUnavailable()));
    yield* Effect.tryPromise({
      try: () =>
        input.db
          .prepare(
            "UPDATE erasure_requests SET connection_blocked=? WHERE id=? AND user_id=? AND state='Draining'"
          )
          .bind(blocked ? 1 : 0, input.scope.reference, input.scope.userId)
          .run(),
      catch: () => new ErasureUnavailable(),
    });
    if (blocked) return;
    const current = yield* Clock.currentTimeMillis;
    const initial: OwnedStatement = {
      sql: `UPDATE erasure_requests SET state='Sealing' WHERE id=? AND user_id=? AND state='Draining'
      AND NOT EXISTS(SELECT 1 FROM erasure_writers WHERE user_id=? AND expires_at_ms>?)`,
      params: [input.scope.reference, input.scope.userId, input.scope.userId, current],
    };
    const statement = input.stores.reduce(
      (selected, store) =>
        store.protectDrained({
          statement: selected,
          scope: input.scope,
          current,
        }),
      initial
    );
    yield* Effect.tryPromise({
      try: () =>
        input.db
          .prepare(statement.sql)
          .bind(...statement.params)
          .run(),
      catch: () => new ErasureUnavailable(),
    });
  });
