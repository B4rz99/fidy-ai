import { Effect, Schema } from "effect";
import {
  type ErasureScope,
  type ErasureStore,
  ErasureUnavailable,
} from "../../erasure-store/contract";

const Stored = Schema.Struct({ storeId: Schema.String });
export const requireInventory = (
  input: Readonly<{ db: D1Database; scope: ErasureScope; stores: ReadonlyArray<ErasureStore> }>
): Effect.Effect<void, ErasureUnavailable> =>
  Effect.gen(function* () {
    const rows = yield* Effect.tryPromise({
      try: () =>
        input.db
          .prepare(`SELECT s.store_id AS storeId FROM erasure_steps s
      JOIN erasure_requests q ON q.id=s.request_id WHERE q.id=? AND q.user_id=?`)
          .bind(input.scope.reference, input.scope.userId)
          .all(),
      catch: () => new ErasureUnavailable(),
    });
    const stored = yield* Schema.decodeUnknownEffect(Schema.Array(Stored))(rows.results);
    if (
      stored.length !== input.stores.length ||
      input.stores.some((store) => !stored.some((row) => row.storeId === store.id))
    ) {
      return yield* new ErasureUnavailable();
    }
  }).pipe(Effect.mapError(() => new ErasureUnavailable()));
