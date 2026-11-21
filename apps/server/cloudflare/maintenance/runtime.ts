import { betaRegistryUrl } from "../beta-pro/contract";
import { readBetaRegistry } from "./internal/beta-registry";
import { runInstalledBackgroundRequest } from "../release-isolation/runtime";
import type { AcceptanceWindowBindings } from "../release-isolation/contract";
import { reportWatchdog, runWatchdog } from "./internal/watchdog";
import type { SharedBindings } from "../storage-bootstrap/contract";
import { handleLifetimeRegistration, lifetimeRequest, maintenanceStoreHistory } from "./operations";
import { DurableObject } from "cloudflare:workers";
import { createStoreRuntime, openSqliteStore, storeReadiness } from "../runtime/sqlite/operations";
import { type StoreReleaseEnvironment, storeReadinessUrl } from "../runtime/sqlite/contract";

import { Effect, Option } from "effect";
import { maintenanceName, watchdogRequest } from "./contract";

type MaintenanceEnvironment = AcceptanceWindowBindings &
  StoreReleaseEnvironment &
  SharedBindings &
  Partial<Readonly<{ RECOVERY_ISOLATION: string }>>;

export class Maintenance extends DurableObject<MaintenanceEnvironment> {
  private readonly runtime;
  private sweeping = false;
  private readonly pending = new Set<Promise<unknown>>();
  constructor(state: DurableObjectState, env: MaintenanceEnvironment) {
    super(state, env);
    this.runtime = createStoreRuntime({
      storage: state.storage,
      owner: maintenanceStoreHistory.owner,
      ceilingBytes: env.SQLITE_STORE_CAPACITY_BYTES,
    });

    if (state.id.name === maintenanceName) {
      state.waitUntil(
        state.blockConcurrencyWhile(() =>
          this.runtime.runPromise(
            openSqliteStore(maintenanceStoreHistory, env.CF_VERSION_METADATA.id)
          )
        )
      );
    }
  }
  private watchdog(request: Request): Promise<Response> {
    return runInstalledBackgroundRequest({
      runtime: this.runtime,
      settings: this.env,
      run: () => this.watchdogTick(request),
    });
  }
  private watchdogTick(request: Request): Promise<Response> {
    const raw = request.headers.get("x-maintenance-scheduled-at");
    const scheduled = Number(raw);

    if (raw === null || !Number.isSafeInteger(scheduled) || scheduled <= 0) {
      return Promise.resolve(new Response(null, { status: 400 }));
    }

    if (this.sweeping) return Promise.resolve(new Response(null, { status: 204 }));

    if (this.pending.size > 0) return Promise.resolve(new Response(null, { status: 503 }));
    this.sweeping = true;

    return this.runtime
      .runPromise(
        runWatchdog(this.env, scheduled, this.pending).pipe(
          Effect.tap((halt) =>
            reportWatchdog(halt, request.headers.get("fidy-native-inspection") === "1")
          ),
          Effect.tap(() =>
            this.pending.size > 0 ? Effect.tryPromise(() => this.ctx.storage.sync()) : Effect.void
          ),
          Effect.timeout("55 seconds")
        )
      )
      .then(
        () => new Response(null, { status: 204 }),
        () => new Response(null, { status: 503 })
      )
      .finally(() => {
        if (this.pending.size > 0) this.ctx.abort("watchdog probe cleanup unavailable");
        this.sweeping = false;
      });
  }
  override fetch(request: Request): Promise<Response> {
    if (this.ctx.id.name !== maintenanceName) {
      return Promise.resolve(new Response(null, { status: 404 }));
    }

    if (request.method === "POST" && request.url === betaRegistryUrl) {
      return this.runtime.runPromise(readBetaRegistry(request));
    }

    if (watchdogRequest(request)) return this.watchdog(request);

    if (lifetimeRequest(request)) {
      return this.runtime.runPromise(
        handleLifetimeRegistration(request, Option.fromUndefinedOr(this.env.ERASURE)).pipe(
          Effect.catchCause(() => Effect.succeed(new Response(null, { status: 503 })))
        )
      );
    }

    if (request.method !== "GET" || request.url !== storeReadinessUrl) {
      return Promise.resolve(new Response(null, { status: 404 }));
    }

    return this.runtime.runPromise(
      storeReadiness({ history: maintenanceStoreHistory, release: this.env.CF_VERSION_METADATA.id })
    );
  }
}
