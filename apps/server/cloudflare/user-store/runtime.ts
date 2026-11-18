import { deliverPendingReplacement } from "../email-authentication/runtime";
import {
  localSupportApproval,
  recoverRotations,
  repairRecoveryAlarm,
  rotateLocalRecovery,
} from "../recovery/operations";
import {
  bootstrapCancelUrl,
  bootstrapCompleteUrl,
  localIdentityCancelUrl,
  localIdentityCommitUrl,
  localRecoveryCheckUrl,
  localSupportUrl,
} from "../directory/contract";
import { repairReplacementAlarm, replacementRequest } from "../email-authentication/operations";
import {
  emailReplacementCompletionPath,
  emailReplacementPath,
} from "../../src/shell/email-authentication/contract";

import { applyIdentityChange } from "./internal/identity-change";

import type { CatalogOperation } from "../../src/shell/canonical-catalog/contract";
import { dispatchLocalBatchRoute, isLocalBatchRoute } from "../canonical-operations/operations";
import {
  dispatchLocalRecurringSeries,
  recoverLocalRecurringSeries,
  repairLocalRecurringAlarm,
} from "../recurring/operations";
import { dispatchLocalRecurringPlans, isLocalRecurringPlan } from "../recurring-plans/operations";
import {
  claimDeliveryUrl,
  replyDeliveryUrl,
  reserveDeliveryUrl,
  statusDeliveryUrl,
} from "../whatsapp/contract";
import { nativeDeliveryRequest } from "../whatsapp/runtime";
import {
  type LocalSourceCancellationWork,
  type WompiBindings,
  collectUserBillingUrl,
  settleUserBillingUrl,
} from "../subscription/contract";
import { handleNativeBillingCallback, handleSourceCancellationWork } from "../subscription/runtime";
import { dispatchLocalForwarding, isLocalForwardingOperation } from "../ingestion/operations";
import { dispatchLocalDashboard, isLocalDashboardOperation } from "../dashboard/operations";
import { dispatchLocalBudget, isLocalBudgetOperation } from "../budgets/operations";
import { browserSessionRequest } from "./internal/browser-session";
import { localChannelRequest, redeemLocalPairing } from "../browser-login/operations";
import { completeLocalBootstrap } from "./internal/bootstrap";

import {
  cancelLocalSubscription,
  offerDueSourceCancellations,
  repairCancellationAlarm,
} from "../subscription/operations";
import { DurableObject } from "cloudflare:workers";
import { createStoreRuntime, openSqliteStore, storeReadiness } from "../runtime/sqlite/operations";
import { Cause, Clock, Effect, Option, Result } from "effect";
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
    RESEND_API_KEY: string;
    DIRECTORY: DurableObjectNamespace;
    USER_STORE: DurableObjectNamespace;
    MAINTENANCE: DurableObjectNamespace;
    BILLING_COLLECTION_QUEUE: Queue<typeof LocalSourceCancellationWork.Type>;
  }>;
const isBrowserObservation = (command: string, request: Request): boolean =>
  ["GET /web/session/binding", "POST /web/session/logout"].includes(command) ||
  (command === "GET /user" && !request.headers.has("authorization"));
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
          deliverPendingReplacement(this.env, this.ctx.storage, this.owns).pipe(
            Effect.mapError((cause) => new Cause.UnknownError(cause))
          ),
          recoverRotations(current, this.env.DIRECTORY, this.ctx.storage).pipe(
            Effect.mapError((cause) => new Cause.UnknownError(cause))
          ),
          recoverLocalRecurringSeries(current, this.ctx.storage, this.owns),
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

  private subscriptionCancellation(
    request: Request,
    owns: (id: string) => boolean,
    operation: CatalogOperation
  ): Promise<Response> {
    return this.runtime.runPromise(
      runLocalMutation({
        request,
        storage: this.ctx.storage,
        operation,
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
    );
  }

  private mutation(
    request: Request,
    owns: (userId: string) => boolean,
    selected: CatalogOperation
  ): Option.Option<Promise<Response>> {
    const unit = { request, owns, operation: selected, storage: this.ctx.storage };
    if (isLocalBatchRoute(selected.id)) {
      return Option.some(this.runtime.runPromise(dispatchLocalBatchRoute(unit)));
    }
    if (selected.id === "subscription.cancelSubscription") {
      return Option.some(this.subscriptionCancellation(request, owns, selected));
    }
    if (selected.id === "recurring.listRecurringSeries") {
      return Option.some(this.runtime.runPromise(dispatchLocalRecurringSeries(unit)));
    }
    if (isLocalRecurringPlan(selected.id)) {
      return Option.some(this.runtime.runPromise(dispatchLocalRecurringPlans(unit)));
    }
    if (isLocalDashboardOperation(selected.id)) {
      return Option.some(this.runtime.runPromise(dispatchLocalDashboard(unit)));
    }
    if (isLocalBudgetOperation(selected.id)) {
      return Option.some(this.runtime.runPromise(dispatchLocalBudget(unit)));
    }
    return this.financialOperation(unit);
  }
  private financialOperation(unit: {
    request: Request;
    owns: (id: string) => boolean;
    operation: CatalogOperation;
    storage: DurableObjectStorage;
  }): Option.Option<Promise<Response>> {
    const selected = unit.operation;
    if (isLocalForwardingOperation(selected.id)) {
      return Option.some(
        this.runtime.runPromise(dispatchLocalForwarding({ ...unit, directory: this.env.DIRECTORY }))
      );
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
    if (
      request.method === "POST" &&
      [bootstrapCompleteUrl, bootstrapCancelUrl, "https://user.invalid/bootstrap/status"].includes(
        request.url
      )
    ) {
      return this.runtime.runPromise(
        completeLocalBootstrap(request, this.env, this.owns).pipe(
          Effect.catchCause(() => Effect.succeed(canonicalAdmissionUnavailable()))
        )
      );
    }
    return this.registration().then(
      (registration) => {
        if (registration === "unavailable" && ownerCheckRequest(request)) {
          return new Response(null, { status: uncertainCheckStatus });
        }
        return this.registeredRequest(request, registration === "registered");
      },
      () => canonicalAdmissionUnavailable()
    );
  }

  private inspectWork(): Promise<Response> {
    const storage = this.ctx.storage;
    const ownsUser = this.owns;
    return this.runtime.runPromise(
      Effect.gen(function* () {
        const current = yield* Clock.currentTimeMillis;
        const inspections = yield* Effect.all(
          [
            repairReplacementAlarm(current, storage),
            repairRecoveryAlarm(current, storage),
            repairReceiptAlarm(current, storage),
            repairCancellationAlarm(storage),
            repairLocalRecurringAlarm(current, storage, ownsUser),
          ],
          { mode: "result", concurrency: 1 }
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

  private identityRequest(
    request: Request,
    owns: (id: string) => boolean
  ): Option.Option<Promise<Response>> {
    if (request.method !== "POST") return Option.none();
    const path = new URL(request.url).pathname;
    const respond = (
      effect: Effect.Effect<
        Response,
        never,
        Effect.Services<Parameters<typeof this.runtime.runPromise>[0]>
      >
    ): Option.Option<Promise<Response>> => Option.some(this.runtime.runPromise(effect));
    if ([emailReplacementPath, emailReplacementCompletionPath].includes(path)) {
      return respond(
        replacementRequest({ request, environment: this.env, owns, storage: this.ctx.storage })
      );
    }
    if ([localIdentityCommitUrl, localIdentityCancelUrl].includes(request.url)) {
      return respond(
        applyIdentityChange(request, owns).pipe(
          Effect.catchCause(() => Effect.succeed(canonicalAdmissionUnavailable()))
        )
      );
    }
    if ([localSupportUrl, localRecoveryCheckUrl].includes(request.url)) {
      return respond(
        localSupportApproval(request, owns).pipe(
          Effect.catchCause(() => Effect.succeed(canonicalAdmissionUnavailable()))
        )
      );
    }
    if (path === "/recovery/backup-code/rotate") {
      return respond(
        rotateLocalRecovery({
          request,
          directory: this.env.DIRECTORY,
          owns,
          storage: this.ctx.storage,
        })
      );
    }
    return Option.none();
  }
  private registeredRequest(request: Request, registered: boolean): Promise<Response> {
    const owns = (userId: string): boolean => registered && this.owns(userId);
    if (
      request.method === "POST" &&
      [claimDeliveryUrl, reserveDeliveryUrl, replyDeliveryUrl, statusDeliveryUrl].includes(
        request.url
      )
    ) {
      return this.runtime.runPromise(
        nativeDeliveryRequest(request, this.env, owns).pipe(
          Effect.catchCause(() => Effect.succeed(canonicalAdmissionUnavailable()))
        )
      );
    }
    if (
      request.method === "POST" &&
      [collectUserBillingUrl, settleUserBillingUrl].includes(request.url)
    ) {
      return this.runtime.runPromise(
        handleNativeBillingCallback(request, this.env, owns).pipe(
          Effect.catchCause(() => Effect.succeed(canonicalAdmissionUnavailable()))
        )
      );
    }
    return this.dispatch(request, registered);
  }

  private dispatch(request: Request, registered: boolean): Promise<Response> {
    const path = new URL(request.url).pathname;
    const command = request.method + " " + path;
    const owns = (userId: string): boolean => registered && this.owns(userId);
    const identity = this.identityRequest(request, owns);
    if (Option.isSome(identity)) return identity.value;
    if (isBrowserObservation(command, request)) {
      return this.runtime.runPromise(browserSessionRequest(request, owns));
    }
    if (["POST /browser/channel-caller", "POST /browser/channel-approval"].includes(command)) {
      return this.runtime.runPromise(
        localChannelRequest(request, this.env.DIRECTORY, owns).pipe(
          Effect.catchCause(() => Effect.succeed(canonicalAdmissionUnavailable()))
        )
      );
    }
    if (command === "POST /browser/redeem") {
      return this.runtime.runPromise(
        redeemLocalPairing(request, this.env.DIRECTORY, owns).pipe(
          Effect.catchCause(() => Effect.succeed(canonicalAdmissionUnavailable()))
        )
      );
    }
    const operation = canonicalOperation({ method: request.method, path });
    const mutation = Option.flatMap(operation, (selected) =>
      this.mutation(request, owns, selected)
    );
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
    return this.workStatus(request, registered);
  }
  private workStatus(request: Request, registered: boolean): Promise<Response> {
    if (ownerCheckRequest(request)) {
      return registered ? this.inspectWork() : Promise.resolve(ownerCheckResponse());
    }
    return Promise.resolve(new Response(null, { status: 404 }));
  }
}
