import { DurableObject } from "cloudflare:workers";
import { directoryHistory } from "./directory/schema/operations";
import { createStoreRuntime, openSqliteStore, storeReadiness } from "./runtime/sqlite/operations";
import {
  type StoreHistory,
  type StoreReleaseEnvironment,
  storeReadinessUrl,
} from "./runtime/sqlite/contract";

export { default, Pricing, Maintenance, Erasure, UserStore } from "./core-worker";

const advanced: StoreHistory = {
  owner: "directory",
  steps: [
    ...directoryHistory.steps,
    {
      version: directoryHistory.steps.length + 1,
      id: "rehearsed-forward-repair",
      statements: ["CREATE TABLE release_rehearsal(id INTEGER PRIMARY KEY) STRICT"],
    },
  ],
};

export class Directory extends DurableObject<StoreReleaseEnvironment> {
  private readonly runtime;
  constructor(state: DurableObjectState, env: StoreReleaseEnvironment) {
    super(state, env);
    this.runtime = createStoreRuntime({
      storage: state.storage,
      owner: "directory",
      ceilingBytes: env.SQLITE_STORE_CAPACITY_BYTES,
    });
    state.waitUntil(
      state.blockConcurrencyWhile(() =>
        this.runtime.runPromise(openSqliteStore(advanced, env.CF_VERSION_METADATA.id))
      )
    );
  }
  override fetch(request: Request): Promise<Response> {
    return request.url === storeReadinessUrl
      ? this.runtime.runPromise(
          storeReadiness({ history: advanced, release: this.env.CF_VERSION_METADATA.id })
        )
      : Promise.resolve(new Response(null, { status: 404 }));
  }
}
