import { prepareFreeze } from "./source-freeze";
import { Effect, Schema } from "effect";
import {
  ErasureGeneration,
  type ErasureSourceFreezePlan,
  ErasureUnavailable,
} from "../../erasure-store/contract";
import { ErasureSourceRetirement } from "../contract";
import { unfinishedFinancialDeletion } from "./source-readiness";

export const sourceGeneration = ({
  db,
}: Readonly<{ db: D1Database }>): Effect.Effect<ErasureGeneration, ErasureUnavailable> =>
  Effect.gen(function* () {
    const row = yield* Effect.tryPromise({
      try: () =>
        db.prepare("SELECT generation FROM erasure_control WHERE kind='published'").first(),
      catch: () => new ErasureUnavailable(),
    });
    return (yield* Schema.decodeUnknownEffect(Schema.Struct({ generation: ErasureGeneration }))(
      row
    )).generation;
  }).pipe(Effect.mapError(() => new ErasureUnavailable()));

/** Native CAS and readiness share one source transaction. The serving generation is never an input. */
export const retireSource = (
  input: Readonly<{ db: D1Database; fence: ErasureSourceRetirement }>
): Effect.Effect<ErasureSourceFreezePlan, ErasureUnavailable> =>
  Effect.gen(function* () {
    const fence = yield* Schema.decodeEffect(ErasureSourceRetirement)(input.fence);
    if (fence.from === fence.retired) return yield* new ErasureUnavailable();
    const freeze = yield* prepareFreeze({ db: input.db, generation: fence.retired });
    yield* Effect.tryPromise({
      try: () =>
        input.db.batch([
          ...freeze.statements,
          freeze.assertion,
          input.db
            .prepare(`SELECT json(CASE WHEN EXISTS(SELECT 1 FROM erasure_control WHERE kind='published' AND generation IN(?,?))
        AND NOT EXISTS(SELECT 1 FROM erasure_requests q WHERE ${unfinishedFinancialDeletion})
        AND NOT EXISTS(SELECT 1 FROM erasure_writers)
        THEN 'true' ELSE '' END) AS ready`)
            .bind(fence.from, fence.retired),
          input.db
            .prepare(
              "UPDATE erasure_control SET generation=? WHERE kind='published' AND generation=?"
            )
            .bind(fence.retired, fence.from),
          input.db
            .prepare(
              "SELECT json(CASE WHEN EXISTS(SELECT 1 FROM erasure_control WHERE kind='published' AND generation=?) THEN 'true' ELSE '' END) AS retired"
            )
            .bind(fence.retired),
        ]),
      catch: () => new ErasureUnavailable(),
    });
    return freeze.plan;
  }).pipe(Effect.mapError(() => new ErasureUnavailable()));
