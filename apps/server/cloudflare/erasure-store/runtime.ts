import { remove } from "./internal/d1";
import type {
  ErasureOriginalConfiguration,
  ErasureOriginals,
  ErasureProjection,
  ErasureStore,
} from "./contract";
import * as originals from "./internal/originals";

/** The owner supplies fixed SQL with a same-User predicate and deletion restricted to the supplied fixed, bounded JSON identifier set. Values must remain bound parameters. */
export const makeErasureStore = (
  input: Readonly<{ db: D1Database; projection: ErasureProjection }>
): ErasureStore => ({
  id: input.projection.id,
  dataClass: input.projection.dataClass,
  dependencies: input.projection.dependencies,
  remove: (scope) => remove({ ...input, scope }),
  protectDrained: ({ statement, scope, current }) => {
    if (input.projection.quiescence._tag === "Synchronous") return statement;
    const pending = input.projection.quiescence.select({ userId: scope.userId, current });
    return {
      sql: `${statement.sql} AND NOT EXISTS(${pending.sql})`,
      params: [...statement.params, ...pending.params],
    };
  },
});

export const makeErasureOriginals = (
  configuration: ErasureOriginalConfiguration
): ErasureOriginals => ({
  discard: (scope) => originals.discard({ configuration, scope }),
});
