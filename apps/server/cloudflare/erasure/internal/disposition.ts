import { Effect, Option, Schema } from "effect";
import {
  type ErasureScope,
  type ErasureStore,
  ErasureUnavailable,
} from "../../erasure-store/contract";

const Step = Schema.Struct({
  storeId: Schema.String,
  deleted: Schema.Literals([0, 1]),
});
const io = <A>(run: () => Promise<A>): Effect.Effect<A, ErasureUnavailable> =>
  Effect.tryPromise({ try: run, catch: () => new ErasureUnavailable() });

export const dispose = (
  input: Readonly<{
    db: D1Database;
    scope: ErasureScope;
    phase: "Erasing";
    stores: ReadonlyArray<ErasureStore>;
  }>
): Effect.Effect<boolean, ErasureUnavailable> =>
  Effect.gen(function* () {
    const raw = yield* io(() =>
      input.db
        .prepare(`SELECT s.store_id AS storeId,s.delete_done AS deleted
    FROM erasure_steps s JOIN erasure_requests q ON q.id=s.request_id WHERE q.id=? AND q.user_id=? AND q.state=?`)
        .bind(input.scope.reference, input.scope.userId, input.phase)
        .all()
    );
    const steps = yield* Schema.decodeUnknownEffect(Schema.Array(Step))(raw.results);
    if (
      steps.length !== input.stores.length ||
      input.stores.some((store) => !steps.some((step) => step.storeId === store.id))
    ) {
      return yield* new ErasureUnavailable();
    }
    const pending = steps.filter((step) => step.deleted === 0);
    if (pending.length === 0) return true;
    const pendingIds = new Set(pending.map((step) => step.storeId));
    const selected = Option.fromUndefinedOr(
      input.stores.find(
        (store) =>
          pendingIds.has(store.id) &&
          store.dependencies.every((dependency) => !pendingIds.has(dependency))
      )
    );
    if (Option.isNone(selected)) return yield* new ErasureUnavailable();
    yield* selected.value.remove(input.scope);
    return false;
  }).pipe(Effect.mapError(() => new ErasureUnavailable()));
