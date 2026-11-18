import { dispatchLocalDashboard, isLocalDashboardOperation } from "../dashboard/operations";
import { dispatchLocalBudget, isLocalBudgetOperation } from "../budgets/operations";
import {
  cancelLocalSubscription,
  offerDueSourceCancellations,
  repairCancellationAlarm,
} from "../subscription/operations";
import { handleSourceCancellationWork } from "../subscription/runtime";
import type { LocalSourceCancellationWork, WompiBindings } from "../subscription/contract";
import { DurableObject } from "cloudflare:workers";
import { createStoreRuntime, openSqliteStore, storeReadiness } from "../runtime/sqlite/operations";
import { Clock, Effect, Option, Result } from "effect";
import { canonicalOperation } from "../routing/operations";
import { dispatchLocalTransaction, isLocalTransactionOperation } from "../transactions/operations";
import {
  canonicalAdmissionUnavailable,
  recoverLocalReceipts,
  repairReceiptAlarm,
  runLocalMutation,
} from "../canonical-admission/operations";
import { observeUserRegistration, recoverUserWork, userStoreHistory } from "./operations";
import {
  type StoreReleaseEnvironment,
  releaseProbeName,
  storeReadinessUrl,
} from "../runtime/sqlite/contract";

import { ownerCheckRequest, ownerCheckResponse } from "../maintenance/contract";

const uncertainCheckStatus = 503;
type UserStoreEnvironment = WompiBindings &
  StoreReleaseEnvironment &
  Readonly<{
    USER_STORE: DurableObjectNamespace;
    MAINTENANCE: DurableObjectNamespace;
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
          recoverLocalReceipts(current, this.ctx.storage),
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
    return this.registration().then((registration) =>
      registration === "registered"
        ? this.checkWork().then((summary) => {
            if (summary.failedFamilies > 0) throw new Error("User work discovery unavailable");
          })
        : undefined
    );
  }

  private mutation(
    request: Request,
    owns: (userId: string) => boolean,
    operation: ReturnType<typeof canonicalOperation>
  ): Option.Option<Promise<Response>> {
    if (Option.isNone(operation)) return Option.none();
    const selected = operation.value;
    const unit = { request, owns, operation: selected, storage: this.ctx.storage };
    if (selected.id === "subscription.cancelSubscription") {
      return Option.some(
        this.runtime.runPromise(
          runLocalMutation({
            request,
            storage: this.ctx.storage,
            operation: operation.value,
            owns,
            input: Effect.succeedSome(true),
            work: (_input, userId, current) =>
              cancelLocalSubscription({ userId, current, storage: this.ctx.storage }),
          }).pipe(
            Effect.tap((response) =>
              Effect.sync(() => {
                if (response.ok) this.ctx.waitUntil(this.alarm());
              })
            ),
            Effect.catchCause(() => Effect.succeed(canonicalAdmissionUnavailable()))
          )
        )
      );
    }
    if (isLocalDashboardOperation(selected.id)) {
      return Option.some(this.runtime.runPromise(dispatchLocalDashboard(unit)));
    }
    if (isLocalBudgetOperation(selected.id)) {
      return Option.some(this.runtime.runPromise(dispatchLocalBudget(unit)));
    }
    if (isLocalTransactionOperation(selected.id)) {
      return Option.some(this.runtime.runPromise(dispatchLocalTransaction(unit)));
    }
    return Option.none();
  }

  private isReleaseProbe(request: Request): boolean {
    return (
      request.method === "GET" &&
      request.url === storeReadinessUrl &&
      this.ctx.id.equals(this.env.USER_STORE.idFromName(releaseProbeName))
    );
  }

  private readonly owns = (userId: string): boolean =>
    this.ctx.id.equals(this.env.USER_STORE.idFromName(userId));

  private registration(): Promise<Effect.Success<ReturnType<typeof observeUserRegistration>>> {
    return this.runtime.runPromise(observeUserRegistration(this.env.MAINTENANCE, this.owns));
  }

  override fetch(request: Request): Promise<Response> {
    if (this.isReleaseProbe(request)) {
      return this.runtime.runPromise(
        storeReadiness({ history: userStoreHistory, release: this.env.CF_VERSION_METADATA.id })
      );
    }
    return this.registration().then(
      (registration) => {
        if (registration === "unavailable" && ownerCheckRequest(request)) {
          return new Response(null, { status: uncertainCheckStatus });
        }
        return this.dispatch(request, registration === "registered");
      },
      () => canonicalAdmissionUnavailable()
    );
  }

  private dispatch(request: Request, registered: boolean): Promise<Response> {
    const path = new URL(request.url).pathname;
    const command = request.method + " " + path;
    const owns = (userId: string): boolean => registered && this.owns(userId);
    const operation = canonicalOperation({ method: request.method, path });
    const mutation = this.mutation(request, owns, operation);
    if (Option.isSome(mutation)) return mutation.value;
    if (
      ["POST /work/source-cancellation/pending", "POST /work/source-cancellation/observe"].includes(
        command
      )
    ) {
      return this.runtime.runPromise(
        handleSourceCancellationWork({
          request,
          environment: this.env,
          owns,
        }).pipe(Effect.catchCause(() => Effect.succeed(new Response(null, { status: 503 }))))
      );
    }
    if (ownerCheckRequest(request)) {
      if (!registered) return Promise.resolve(ownerCheckResponse());
      const storage = this.ctx.storage;
      return this.runtime.runPromise(
        Effect.gen(function* () {
          const current = yield* Clock.currentTimeMillis;
          const inspections = yield* Effect.forEach(
            [repairReceiptAlarm(current, storage), repairCancellationAlarm(storage)],
            Effect.result
          );
          if (inspections.some(Result.isFailure)) {
            return new Response(null, { status: uncertainCheckStatus });
          }
          return ownerCheckResponse(
            inspections.some((result) => Result.isSuccess(result) && result.success)
          );
        })
      );
    }
    return Promise.resolve(new Response(null, { status: 404 }));
  }
}
