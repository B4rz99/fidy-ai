import { offerDueSourceCancellations } from "../subscription/operations";
import { handleSourceCancellationWork } from "../subscription/runtime";
import type { LocalSourceCancellationWork, WompiBindings } from "../subscription/contract";
import { DurableObject } from "cloudflare:workers";
import { createStoreRuntime, openSqliteStore } from "../runtime/sqlite/operations";
import { Clock, Effect } from "effect";
import { canonicalAdmissionUnavailable } from "../canonical-admission/operations";
import { readUserHistory } from "../transactions/operations";
import { recoverUserWork, userStoreHistory } from "./operations";
import type { StoreReleaseEnvironment } from "../runtime/sqlite/contract";

const completedCheckStatus = 200;
const uncertainCheckStatus = 503;
type UserStoreEnvironment = WompiBindings &
  StoreReleaseEnvironment &
  Readonly<{
    USER_STORE: DurableObjectNamespace;
    BILLING_COLLECTION_QUEUE: Queue<typeof LocalSourceCancellationWork.Type>;
  }>;
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

  private checkWork(): Promise<
    Readonly<{ failedFamilies: number; attempted: number; failedOffers: number }>
  > {
    return this.runtime.runPromise(
      Effect.flatMap(Clock.currentTimeMillis, (current) =>
        recoverUserWork([
          offerDueSourceCancellations({
            current,
            storage: this.ctx.storage,
            queue: this.env.BILLING_COLLECTION_QUEUE,
          }),
        ])
      )
    );
  }

  override alarm(): Promise<void> {
    return this.checkWork().then((summary) => {
      if (summary.failedFamilies > 0) throw new Error("User work discovery unavailable");
    });
  }

  override fetch(request: Request): Promise<Response> {
    const command = request.method + " " + new URL(request.url).pathname;
    if (
      ["POST /work/source-cancellation/pending", "POST /work/source-cancellation/observe"].includes(
        command
      )
    ) {
      return this.runtime.runPromise(
        handleSourceCancellationWork({
          request,
          environment: this.env,
          owns: (userId) => this.ctx.id.equals(this.env.USER_STORE.idFromName(userId)),
        }).pipe(Effect.catchCause(() => Effect.succeed(new Response(null, { status: 503 }))))
      );
    }
    if (command === "POST /work/check") {
      return this.checkWork().then((summary) =>
        Response.json(summary, {
          status: summary.failedFamilies > 0 ? uncertainCheckStatus : completedCheckStatus,
        })
      );
    }
    if (command !== "GET /transactions" || request.headers.has("authorization")) {
      return Promise.resolve(new Response(null, { status: 404 }));
    }
    return this.runtime.runPromise(
      readUserHistory(request, (userId) =>
        this.ctx.id.equals(this.env.USER_STORE.idFromName(userId))
      ).pipe(Effect.catchCause(() => Effect.succeed(canonicalAdmissionUnavailable())))
    );
  }
}
