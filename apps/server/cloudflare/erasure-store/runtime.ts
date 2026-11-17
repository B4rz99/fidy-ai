import { DurableObject } from "cloudflare:workers";
import { createStoreRuntime, openSqliteStore, storeReadiness } from "../runtime/sqlite/operations";
import { type StoreReleaseEnvironment, storeReadinessUrl } from "../runtime/sqlite/contract";
import { erasureStoreHistory } from "./operations";
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

export class Erasure extends DurableObject<StoreReleaseEnvironment> {
  private readonly runtime;
  constructor(state: DurableObjectState, env: StoreReleaseEnvironment) {
    super(state, env);
    this.runtime = createStoreRuntime({
      storage: state.storage,
      owner: erasureStoreHistory.owner,
      ceilingBytes: env.SQLITE_STORE_CAPACITY_BYTES,
    });
    if (state.id.name === "erasure-registry-v1") {
      state.waitUntil(
        state.blockConcurrencyWhile(() =>
          this.runtime.runPromise(openSqliteStore(erasureStoreHistory, env.CF_VERSION_METADATA.id))
        )
      );
    }
  }
  override fetch(request: Request): Promise<Response> {
    if (
      this.ctx.id.name !== "erasure-registry-v1" ||
      request.method !== "GET" ||
      request.url !== storeReadinessUrl
    ) {
      return Promise.resolve(new Response(null, { status: 404 }));
    }
    return this.runtime.runPromise(
      storeReadiness({ history: erasureStoreHistory, release: this.env.CF_VERSION_METADATA.id })
    );
  }
}
