import { createStorageControl } from "../storage-operations/runtime";
import { confirmCleanup } from "./internal/settlement";
import { confirmPurge, emptyUserDisposition } from "./internal/local-purge";
import {
  confirmCleanupUrl,
  confirmDrainUrl,
  confirmLifetimeCaseUrl,
  confirmPurgeUrl,
  erasedUserUrl,
  registerCaseUrl,
} from "./contract";
import { caseOperatorRequest } from "../erasure/operations";
import { Effect, Option } from "effect";
import { erasureRegistryName } from "../erasure/contract";
import { ownerCheckRequest, ownerCheckResponse } from "../maintenance/contract";
import {
  advanceErasureCases,
  confirmLifetimeCase,
  registerErasureCase,
  repairCaseAlarm,
} from "./internal/cases";
import { DurableObject } from "cloudflare:workers";
import { createStoreRuntime, storeReadiness } from "../runtime/sqlite/operations";
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
  private readonly control;
  private readonly runtime;
  constructor(state: DurableObjectState, env: ErasureEnvironment) {
    super(state, env);
    this.runtime = createStoreRuntime({
      storage: state.storage,
      owner: erasureStoreHistory.owner,
      ceilingBytes: env.SQLITE_STORE_CAPACITY_BYTES,
    });
    this.control = createStorageControl({
      state,
      runtime: this.runtime,
      history: erasureStoreHistory,
      release: env.CF_VERSION_METADATA.id,
    });
    if (state.id.equals(env.ERASURE.idFromName(erasureRegistryName))) {
      state.waitUntil(
        state.blockConcurrencyWhile(() => this.runtime.runPromise(this.control.open()))
      );
    }
  }
  override alarm(): Promise<void> {
    if (this.control.failed()) return Promise.reject(new Error("Store schema unavailable"));
    return this.runtime.runPromise(advanceErasureCases(this.ctx.storage, this.env));
  }
  private command(request: Request): Promise<Response> {
    const unavailable = Effect.catchCause(() =>
      Effect.succeed(new Response(null, { status: 503 }))
    );
    if ([confirmDrainUrl, confirmPurgeUrl].includes(request.url)) {
      return this.runtime.runPromise(confirmPurge(request).pipe(unavailable));
    }
    switch (request.url) {
      case confirmCleanupUrl:
        return this.runtime.runPromise(confirmCleanup(request).pipe(unavailable));
      case erasedUserUrl:
        return this.runtime.runPromise(emptyUserDisposition(request).pipe(unavailable));
      case confirmLifetimeCaseUrl:
        return this.runtime.runPromise(confirmLifetimeCase(request).pipe(unavailable));
      case registerCaseUrl:
        return this.runtime.runPromise(
          registerErasureCase(request, this.env.USER_STORE, this.ctx.storage).pipe(unavailable)
        );
      default:
        return this.runtime.runPromise(
          caseOperatorRequest(request, this.ctx.storage, this.env.DIRECTORY).pipe(unavailable)
        );
    }
  }
  override fetch(request: Request): Promise<Response> {
    if (!this.ctx.id.equals(this.env.ERASURE.idFromName(erasureRegistryName))) {
      return Promise.resolve(new Response(null, { status: 404 }));
    }
    const controlled = this.control.guard(request);
    if (Option.isSome(controlled)) return controlled.value;
    if (ownerCheckRequest(request)) {
      return this.runtime.runPromise(
        repairCaseAlarm(this.ctx.storage).pipe(
          Effect.map(ownerCheckResponse),
          this.control.observeCheck
        )
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
