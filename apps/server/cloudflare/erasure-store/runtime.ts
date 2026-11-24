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
import { Effect } from "effect";
import { erasureRegistryName } from "../erasure/contract";
import { ownerCheckRequest, ownerCheckResponse } from "../maintenance/contract";
import {
  advanceErasureCases,
  confirmLifetimeCase,
  registerErasureCase,
  repairCaseAlarm,
} from "./internal/cases";
import { DurableObject } from "cloudflare:workers";
import {
  createStoreRuntime,
  observeStoreCheck,
  openSqliteStore,
  storeReadiness,
} from "../runtime/sqlite/operations";
import { type StoreReleaseEnvironment, storeReadinessUrl } from "../runtime/sqlite/contract";
import { erasureStoreHistory } from "./operations";

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
    const unavailable = <E, R>(
      command: Effect.Effect<Response, E, R>
    ): Effect.Effect<Response, never, R> =>
      command.pipe(
        Effect.tapCause(() =>
          Effect.logWarning({
            component: "erasure-store",
            operation: "command",
            outcome: "unavailable",
          })
        ),
        Effect.catchCause(() => Effect.succeed(new Response(null, { status: 503 })))
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

    if (ownerCheckRequest(request)) {
      return this.runtime.runPromise(
        repairCaseAlarm(this.ctx.storage).pipe(
          Effect.map(ownerCheckResponse),
          observeStoreCheck({
            storage: this.ctx.storage,
            history: erasureStoreHistory,
            release: this.env.CF_VERSION_METADATA.id,
          })
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
