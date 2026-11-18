import { caseOperatorRequest } from "../erasure/operations";
import { Effect } from "effect";
import { confirmLifetimeCaseUrl, registerCaseUrl } from "./contract";
import { erasureRegistryName } from "../erasure/contract";
import { ownerCheckRequest, ownerCheckResponse } from "../maintenance/contract";
import {
  advanceErasureCases,
  confirmLifetimeCase,
  registerErasureCase,
  repairCaseAlarm,
} from "./internal/cases";
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

type ErasureEnvironment = StoreReleaseEnvironment & {
  USER_STORE: DurableObjectNamespace;
  ERASURE: DurableObjectNamespace;
  DIRECTORY: DurableObjectNamespace;
  PRICING: DurableObjectNamespace;
  MAINTENANCE: DurableObjectNamespace;
};
export class Erasure extends DurableObject<ErasureEnvironment> {
  private readonly runtime;
  constructor(state: DurableObjectState, env: ErasureEnvironment) {
    super(state, env);
    this.runtime = createStoreRuntime({
      storage: state.storage,
      owner: erasureStoreHistory.owner,
      ceilingBytes: env.SQLITE_STORE_CAPACITY_BYTES,
    });
    if (state.id.equals(env.ERASURE.idFromName(erasureRegistryName))) {
      state.waitUntil(
        state.blockConcurrencyWhile(() =>
          this.runtime.runPromise(openSqliteStore(erasureStoreHistory, env.CF_VERSION_METADATA.id))
        )
      );
    }
  }
  override alarm(): Promise<void> {
    return this.runtime.runPromise(advanceErasureCases(this.ctx.storage, this.env));
  }
  private command(request: Request): Promise<Response> {
    const unavailable = Effect.catchCause(() =>
      Effect.succeed(new Response(null, { status: 503 }))
    );
    switch (request.url) {
      case confirmLifetimeCaseUrl:
        return this.runtime.runPromise(confirmLifetimeCase(request).pipe(unavailable));
      case registerCaseUrl:
        return this.runtime.runPromise(
          registerErasureCase(request, this.env.USER_STORE, this.ctx.storage).pipe(unavailable)
        );
      case "https://coordinator.internal/erasure-receipt":
      case "https://coordinator.internal/erasure-continue":
        return this.runtime.runPromise(
          caseOperatorRequest(request, this.ctx.storage).pipe(unavailable)
        );
      case "https://coordinator.internal/erasure-custody-evidence":
        return Promise.resolve(new Response(null, { status: 409 }));
      default:
        return Promise.resolve(new Response(null, { status: 404 }));
    }
  }
  override fetch(request: Request): Promise<Response> {
    if (!this.ctx.id.equals(this.env.ERASURE.idFromName(erasureRegistryName))) {
      return Promise.resolve(new Response(null, { status: 404 }));
    }
    if (ownerCheckRequest(request)) {
      return this.runtime.runPromise(
        repairCaseAlarm(this.ctx.storage).pipe(Effect.map(ownerCheckResponse))
      );
    }
    if (request.method === "POST") return this.command(request);
    if (request.method !== "GET" || request.url !== storeReadinessUrl) {
      return Promise.resolve(new Response(null, { status: 404 }));
    }
    return this.runtime.runPromise(
      storeReadiness({ history: erasureStoreHistory, release: this.env.CF_VERSION_METADATA.id })
    );
  }
}
