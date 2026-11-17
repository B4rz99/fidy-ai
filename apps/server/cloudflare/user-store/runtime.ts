import { createStoreRuntime, openSqliteStore, storeReadiness } from "../runtime/sqlite/operations";
import {
  type StoreReleaseEnvironment,
  releaseProbeName,
  storeReadinessUrl,
} from "../runtime/sqlite/contract";

import { DurableObject } from "cloudflare:workers";
import { Effect, Option } from "effect";
import { canonicalOperation } from "../routing/operations";
import { canonicalAdmissionUnavailable, runLocalMutation } from "../canonical-admission/operations";
import {
  captureLocalTransaction,
  readUserHistory,
  transactionInput,
} from "../transactions/operations";
import { userStoreHistory } from "./operations";

type UserStoreEnvironment = StoreReleaseEnvironment &
  Readonly<{ USER_STORE: DurableObjectNamespace }>;
export class UserStore extends DurableObject<UserStoreEnvironment> {
  private readonly runtime;
  constructor(state: DurableObjectState, env: UserStoreEnvironment) {
    super(state, env);
    this.runtime = createStoreRuntime({
      storage: state.storage,
      owner: "user",
      ceilingBytes: env.SQLITE_STORE_CAPACITY_BYTES,
    });
    state.waitUntil(
      state.blockConcurrencyWhile(() =>
        this.runtime.runPromise(openSqliteStore(userStoreHistory, env.CF_VERSION_METADATA.id))
      )
    );
  }

  override fetch(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname;
    const owns = (userId: string): boolean =>
      this.ctx.id.equals(this.env.USER_STORE.idFromName(userId));
    const operation = canonicalOperation({ method: request.method, path });
    if (Option.isSome(operation) && operation.value.id === "transactions.createTransaction") {
      return this.runtime.runPromise(
        runLocalMutation({
          request,
          operation: operation.value,
          owns,
          input: transactionInput(request),
          work: captureLocalTransaction,
        }).pipe(Effect.catchCause(() => Effect.succeed(canonicalAdmissionUnavailable())))
      );
    }
    if (
      request.method === "GET" &&
      request.url === storeReadinessUrl &&
      this.ctx.id.equals(this.env.USER_STORE.idFromName(releaseProbeName))
    ) {
      return this.runtime.runPromise(
        storeReadiness({ history: userStoreHistory, release: this.env.CF_VERSION_METADATA.id })
      );
    }
    if (
      request.method !== "GET" ||
      new URL(request.url).pathname !== "/transactions" ||
      request.headers.has("authorization")
    ) {
      return Promise.resolve(new Response(null, { status: 404 }));
    }
    return this.runtime.runPromise(
      readUserHistory(request, owns).pipe(
        Effect.catchCause(() => Effect.succeed(canonicalAdmissionUnavailable()))
      )
    );
  }
}
