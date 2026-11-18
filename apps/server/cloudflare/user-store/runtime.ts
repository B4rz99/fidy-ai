import { HttpClient } from "effect/http";
import { Cause, Clock, Context, Effect, Layer, Option, Result } from "effect";
import { OutboundHttpLive } from "../outbound-http/runtime";
import {
  type LocalIngestionEnvironment,
  localDocumentUrl,
  localEmailUrl,
  localSampleReviewUrl,
} from "../ingestion/contract";
import {
  admitLocalDocument,
  admitLocalEmail,
  localPendingStatement,
  localSampleReview,
  localStatementActivity,
  processLocalEmail,
  recoverLocalIngestion,
  repairLocalIngestionAlarm,
} from "../ingestion/runtime";
import {
  checkConnectionAlarm,
  cleanConnectionGrants,
  expireConnectionAttempts,
  nativeConnectionBrowser,
  offerConnectionWork,
  repairConnectionRetention,
  runConnectionWork,
  sandboxConnectionAdapters,
} from "../connections/runtime";
import {
  type ConnectionAdapters,
  ConnectionSandboxAdmission,
  type SynchronizationWork,
  connectionCallbackPath,
} from "../connections/contract";
import { connectionBrowserTransport } from "../../src/shell/connections/runtime";
import type { BancolombiaSandboxEnvironment } from "../bancolombia-authentication/contract";
import { bancolombiaSandboxAdmission } from "../bancolombia-authentication/runtime";
import { localPATClaimUrl } from "../tokens/contract";
import { type McpResidency, localProtocolAdmission, makeMcpResidency } from "../mcp/runtime";
import {
  denyMcpAccess,
  handleLocalOAuthManagement,
  handleOAuthReview,
  handleOAuthToken,
  localOAuthAccessSubject,
  localOAuthCanonicalRequest,
  resolveLocalOAuthCaller,
} from "../oauth-agents/operations";
import {
  CurrentOAuthInvocation,
  OAuthMcpCallerUnavailable,
  oauthTokenDestinationUrl,
} from "../oauth-agents/contract";
import { oauthPaths } from "../../src/shell/oauth-agents/contract";

import {
  claimLocalPAT,
  dispatchLocalPATGrant,
  dispatchLocalPATManagement,
  isLocalPATGrant,
  isLocalPATManagement,
  recoverLocalPATExpiry,
  repairLocalPATExpiry,
} from "../tokens/operations";
import {
  deliverPendingReplacement,
  localLoginEmailRequest,
  offerLoginEmail,
  repairLoginAlarm,
} from "../email-authentication/runtime";
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
import {
  type NativeLoginEmailWork,
  loginCheckUrl,
  loginDeliverUrl,
  loginStartUrl,
  loginVerifyUrl,
} from "../email-authentication/contract";
import { repairReplacementAlarm, replacementRequest } from "../email-authentication/operations";
import {
  emailReplacementCompletionPath,
  emailReplacementPath,
} from "../../src/shell/email-authentication/contract";

import { applyIdentityChange } from "./internal/identity-change";

import type { CatalogOperation } from "../../src/shell/canonical-catalog/contract";
import {
  dispatchLocalBatchRoute,
  isLocalBatchRoute,
  localOAuthReviewBinding,
} from "../canonical-operations/operations";
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
  type LocalBillingCollection,
  type LocalSourceCancellationWork,
  type WompiBindings,
  collectUserBillingUrl,
  settleUserBillingUrl,
} from "../subscription/contract";
import { paymentEnrollmentTransport } from "../../src/shell/subscription/runtime";
import {
  answerRegistration,
  billingWake,
  handleLocalEnrollment,
  handleNativeBillingCallback,
  handleSourceCancellationWork,
  offerLocalBilling,
} from "../subscription/runtime";
import {
  dispatchLocalForwarding,
  dispatchLocalReview,
  isLocalForwardingOperation,
  isLocalReviewOperation,
} from "../ingestion/operations";
import { dispatchLocalDashboard, isLocalDashboardOperation } from "../dashboard/operations";
import { dispatchLocalBudget, isLocalBudgetOperation } from "../budgets/operations";
import { browserSessionRequest } from "./internal/browser-session";
import { localChannelRequest, redeemLocalPairing } from "../browser-login/operations";
import { completeLocalBootstrap } from "./internal/bootstrap";

import {
  cancelLocalSubscription,
  isLocalSubscriptionRead,
  observeLocalSubscription,
  offerDueSourceCancellations,
  repairCancellationAlarm,
} from "../subscription/operations";
import { DurableObject } from "cloudflare:workers";
import { createStoreRuntime, openSqliteStore, storeReadiness } from "../runtime/sqlite/operations";

import { canonicalOperation } from "../routing/operations";
import { dispatchLocalTransaction, isLocalTransactionOperation } from "../transactions/operations";
import {
  canonicalAdmissionUnavailable,
  dispatchNativeExternalRead,
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
  LocalIngestionEnvironment &
  BancolombiaSandboxEnvironment &
  StoreReleaseEnvironment &
  Readonly<{
    PRICING: DurableObjectNamespace;
    BROWSER_ORIGIN: string;
    RESEND_API_KEY: string;
    BROWSER_PAIRING_EMAIL_QUEUE: Queue<typeof NativeLoginEmailWork.Type>;
    DIRECTORY: DurableObjectNamespace;
    USER_STORE: DurableObjectNamespace;
    MAINTENANCE: DurableObjectNamespace;
    CONNECTION_SYNCHRONIZATION_QUEUE: Queue<SynchronizationWork>;
    BILLING_COLLECTION_QUEUE: Queue<
      typeof LocalSourceCancellationWork.Type | typeof LocalBillingCollection.Type
    >;
  }>;
const isBrowserObservation = (command: string, request: Request): boolean =>
  ["GET /web/session/binding", "POST /web/session/logout"].includes(command) ||
  (command === "GET /user" && !request.headers.has("authorization"));
export class UserStore extends DurableObject<UserStoreEnvironment> {
  protected connectionAdapters(): ConnectionAdapters {
    return sandboxConnectionAdapters({ environment: this.env, userId: this.ctx.id.name ?? "" });
  }
  private readonly runtime;
  private mcp?: McpResidency;
  private protocol(request: Request, owns: (id: string) => boolean): Promise<Response> {
    return this.runtime.runPromise(
      Effect.gen({ self: this }, function* () {
        const credential = yield* localOAuthAccessSubject(request, owns);
        if (Option.isNone(credential)) return denyMcpAccess();
        const admission = yield* localProtocolAdmission(request, credential.value);
        this.mcp ??= makeMcpResidency({
          userId: admission.userId,
          resolveCaller: (input) =>
            Effect.tryPromise({
              try: () => this.runtime.runPromise(resolveLocalOAuthCaller(input)),
              catch: () => new OAuthMcpCallerUnavailable(),
            }),
          enqueueCanonicalWork: ({ admission: call, signal }) =>
            Effect.gen({ self: this }, function* () {
              const prepared = yield* localOAuthCanonicalRequest(call, signal);
              if (prepared instanceof Response) return prepared;
              const answer = this.mutation(prepared.request, owns, prepared.operation);
              const work = Option.getOrElse(answer, () =>
                dispatchNativeExternalRead({
                  request: prepared.request,
                  owns,
                  operation: prepared.operation,
                  storage: this.ctx.storage,
                })
              );
              const localized = work.pipe(
                Effect.provideService(
                  CurrentOAuthInvocation,
                  Option.some({
                    ...prepared.oauth,
                    review: (current) =>
                      localOAuthReviewBinding(call, {
                        user: call.userId,
                        current,
                        storage: this.ctx.storage,
                      }),
                  })
                )
              );
              return yield* Effect.tryPromise(() => this.runtime.runPromise(localized));
            }).pipe(Effect.catchCause(() => Effect.succeed(canonicalAdmissionUnavailable()))),
        });
        return yield* this.mcp.handle({ admission, signal: request.signal });
      }).pipe(Effect.catchCause(() => Effect.succeed(canonicalAdmissionUnavailable())))
    );
  }
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
      Effect.flatMap(Clock.currentTimeMillis, (current) => {
        const families = [
          offerLoginEmail(this.env.BROWSER_PAIRING_EMAIL_QUEUE, this.ctx.storage).pipe(
            Effect.mapError((cause) => new Cause.UnknownError(cause))
          ),
          deliverPendingReplacement(this.env, this.ctx.storage, this.owns).pipe(
            Effect.mapError((cause) => new Cause.UnknownError(cause))
          ),
          offerLocalBilling({ env: this.env, storage: this.ctx.storage, owns: this.owns }).pipe(
            Effect.mapError((cause) => new Cause.UnknownError(cause))
          ),
          recoverRotations(current, this.env.DIRECTORY, this.ctx.storage).pipe(
            Effect.mapError((cause) => new Cause.UnknownError(cause))
          ),
          recoverLocalRecurringSeries(current, this.ctx.storage, this.owns),
          recoverLocalReceipts(current, this.ctx.storage),
          Effect.scoped(
            Effect.flatMap(Layer.build(OutboundHttpLive), (clients) =>
              recoverLocalIngestion(current, this.ctx.storage, this.env).pipe(
                Effect.provideService(
                  HttpClient.HttpClient,
                  Context.get(clients, HttpClient.HttpClient)
                )
              )
            )
          ).pipe(Effect.mapError((cause) => new Cause.UnknownError(cause))),
          expireConnectionAttempts({
            storage: this.ctx.storage,
            now: current,
            adapters: this.connectionAdapters(),
          }),
          cleanConnectionGrants({
            storage: this.ctx.storage,
            adapters: this.connectionAdapters(),
            owns: this.owns,
          }),
          offerConnectionWork({
            now: current,
            storage: this.ctx.storage,
            queue: this.env.CONNECTION_SYNCHRONIZATION_QUEUE,
            owns: this.owns,
            environment: this.env,
          }),
          recoverLocalPATExpiry(current, this.ctx.storage),
          offerDueSourceCancellations({
            current,
            storage: this.ctx.storage,
            queue: this.env.BILLING_COLLECTION_QUEUE,
          }),
        ] as const;
        type Work = (typeof families)[number];
        return recoverUserWork<Effect.Error<Work>, Effect.Services<Work>>(families);
      })
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

  private patOperation(
    unit: Parameters<typeof dispatchLocalPATManagement>[0]
  ): Option.Option<ReturnType<typeof dispatchLocalBudget>> {
    const onFailure = Effect.catchCause(() => Effect.succeed(canonicalAdmissionUnavailable()));
    if (isLocalPATManagement(unit.operation.id)) {
      return Option.some(
        dispatchLocalPATManagement(unit).pipe(
          Effect.flatMap((plan) => runLocalMutation(plan)),
          onFailure
        )
      );
    }
    if (isLocalPATGrant(unit.operation.id)) {
      return Option.some(
        dispatchLocalPATGrant({ ...unit, directory: this.env.DIRECTORY }).pipe(
          Effect.flatMap((plan) => runLocalMutation(plan)),
          onFailure
        )
      );
    }
    return Option.none();
  }
  private mutation(
    request: Request,
    owns: (user: string) => boolean,
    operation: CatalogOperation
  ): Option.Option<ReturnType<typeof dispatchLocalBudget>> {
    const unit = { request, owns, operation, storage: this.ctx.storage };
    const directory = this.env.DIRECTORY;
    const onFailure = Effect.catchCause(() => Effect.succeed(canonicalAdmissionUnavailable()));
    const pat = this.patOperation(unit);
    if (Option.isSome(pat)) return pat;
    if (isLocalBatchRoute(operation.id)) {
      return Option.some(
        dispatchLocalBatchRoute({ ...unit, directory }).pipe(
          Effect.provideService(ConnectionSandboxAdmission, bancolombiaSandboxAdmission(this.env))
        )
      );
    }
    if (operation.id === "subscription.cancelSubscription") {
      return Option.some(
        runLocalMutation({
          ...unit,
          input: Effect.succeedSome(true),
          work: (_input, userId, current) =>
            cancelLocalSubscription({ userId, current, storage: unit.storage }),
        }).pipe(
          Effect.tap((response) =>
            Effect.sync(() => {
              if (response.ok) this.ctx.waitUntil(this.alarm());
            })
          ),
          onFailure
        )
      );
    }
    for (const [matches, dispatch] of [
      [
        (id: string): boolean => id === "recurring.listRecurringSeries",
        dispatchLocalRecurringSeries,
      ],
      [
        isLocalForwardingOperation,
        () => dispatchLocalForwarding({ ...unit, directory: this.env.DIRECTORY }),
      ],
      [isLocalSubscriptionRead, () => observeLocalSubscription(unit, this.env.PRICING)],
      [
        isLocalReviewOperation,
        () => dispatchLocalReview({ ...unit, bucket: this.env.EMAIL_BUCKET }),
      ],
      [isLocalRecurringPlan, dispatchLocalRecurringPlans],
      [isLocalDashboardOperation, dispatchLocalDashboard],
      [isLocalBudgetOperation, dispatchLocalBudget],
      [isLocalTransactionOperation, dispatchLocalTransaction],
    ] as const) {
      if (matches(operation.id)) return Option.some(dispatch(unit));
    }
    return request.headers.has("authorization")
      ? Option.some(dispatchNativeExternalRead(unit))
      : Option.none();
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
    const adapters = this.connectionAdapters();
    return this.runtime.runPromise(
      Effect.gen(function* () {
        const current = yield* Clock.currentTimeMillis;
        const inspections = yield* Effect.all(
          [
            repairLoginAlarm(current, storage),
            repairReplacementAlarm(current, storage),
            repairRecoveryAlarm(current, storage),
            repairReceiptAlarm(current, storage),
            repairLocalIngestionAlarm(current, storage),
            checkConnectionAlarm(storage),
            repairConnectionRetention({ storage, adapters }),
            repairLocalPATExpiry(current, storage),
            repairCancellationAlarm(storage),
            billingWake(storage),
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

  private ingestionRequest(
    request: Request,
    owns: (id: string) => boolean
  ): Option.Option<Promise<Response>> {
    const unit = { request, env: this.env, owns, storage: this.ctx.storage };
    switch (request.url) {
      case localSampleReviewUrl:
      case localEmailUrl:
        return Option.some(
          this.runtime.runPromise(
            Effect.catchCause(
              request.url === localEmailUrl ? admitLocalEmail(unit) : localSampleReview(unit),
              () => Effect.succeed(canonicalAdmissionUnavailable())
            )
          )
        );
      case "https://coordinator.internal/forwarded-email-work":
        return Option.some(
          this.runtime.runPromise(
            processLocalEmail(request, this.env, owns).pipe(
              Effect.catchCause(() => Effect.succeed(canonicalAdmissionUnavailable()))
            )
          )
        );
      case "https://coordinator.internal/statement-work":
        return Option.some(
          this.runtime.runPromise(
            localStatementActivity(request, this.env.STATEMENT_STAGING_BUCKET, owns).pipe(
              Effect.catchCause(() => Effect.succeed(canonicalAdmissionUnavailable()))
            )
          )
        );
      case "https://user.invalid/ingestion/statement/pending":
        return Option.some(
          this.runtime.runPromise(
            localPendingStatement(request, owns).pipe(
              Effect.catchCause(() => Effect.succeed(canonicalAdmissionUnavailable()))
            )
          )
        );
      case localDocumentUrl:
        return Option.some(
          this.runtime.runPromise(
            Effect.scoped(
              Effect.flatMap(Layer.build(OutboundHttpLive), (clients) =>
                admitLocalDocument(unit).pipe(
                  Effect.provideService(
                    HttpClient.HttpClient,
                    Context.get(clients, HttpClient.HttpClient)
                  )
                )
              )
            ).pipe(Effect.catchCause(() => Effect.succeed(canonicalAdmissionUnavailable())))
          )
        );
      default:
        return Option.none();
    }
  }

  private readonly retireMcp = (connection: Option.Option<string>): Effect.Effect<void> =>
    this.mcp?.retireConnections(connection) ?? Effect.void;

  private credentialRequest(
    request: Request,
    path: string,
    owns: (id: string) => boolean
  ): Option.Option<Promise<Response>> {
    if (
      [oauthPaths.connections, oauthPaths.revoke, oauthPaths.revokeAll].some(
        (candidate) => candidate === path
      )
    ) {
      return Option.some(
        this.runtime.runPromise(
          handleLocalOAuthManagement({
            request,
            owns,
            origin: this.env.BROWSER_ORIGIN,
            retire: this.retireMcp,
          })
        )
      );
    }
    if (path === oauthPaths.mcp) return Option.some(this.protocol(request, owns));
    if (request.url === oauthTokenDestinationUrl && request.method === "POST") {
      return Option.some(
        this.runtime.runPromise(
          handleOAuthToken(request, { directory: this.env.DIRECTORY, owns, retire: this.retireMcp })
        )
      );
    }
    if (
      [oauthPaths.review, oauthPaths.connect, oauthPaths.cancel].some(
        (candidate) => candidate === path
      )
    ) {
      return Option.some(
        this.runtime.runPromise(
          handleOAuthReview({
            request,
            directory: this.env.DIRECTORY,
            owns,
            origin: this.env.BROWSER_ORIGIN,
          })
        )
      );
    }
    return Option.none();
  }
  private browserRequest(
    request: Request,
    command: string,
    owns: (id: string) => boolean
  ): Option.Option<Promise<Response>> {
    if (isBrowserObservation(command, request)) {
      return Option.some(this.runtime.runPromise(browserSessionRequest(request, owns)));
    }
    if (["POST /browser/channel-caller", "POST /browser/channel-approval"].includes(command)) {
      return Option.some(
        this.runtime.runPromise(
          localChannelRequest(request, this.env.DIRECTORY, owns).pipe(
            Effect.catchCause(() => Effect.succeed(canonicalAdmissionUnavailable()))
          )
        )
      );
    }
    if (request.method === "POST" && request.url === localPATClaimUrl) {
      return Option.some(this.runtime.runPromise(claimLocalPAT(request, this.env.DIRECTORY, owns)));
    }
    if (command === "POST /browser/redeem") {
      return Option.some(
        this.runtime.runPromise(
          redeemLocalPairing(request, this.env.DIRECTORY, owns).pipe(
            Effect.catchCause(() => Effect.succeed(canonicalAdmissionUnavailable()))
          )
        )
      );
    }
    return Option.none();
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
    if ([loginCheckUrl, loginDeliverUrl, loginVerifyUrl, loginStartUrl].includes(request.url)) {
      return respond(
        localLoginEmailRequest({
          request,
          environment: this.env,
          storage: this.ctx.storage,
          owns,
        }).pipe(Effect.catchCause(() => Effect.succeed(canonicalAdmissionUnavailable())))
      );
    }
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
    if (request.method === "POST") {
      const ingestion = this.ingestionRequest(request, owns);
      if (Option.isSome(ingestion)) return ingestion.value;
    }
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
        handleNativeBillingCallback({
          request,
          env: this.env,
          owns,
          storage: this.ctx.storage,
        }).pipe(Effect.catchCause(() => Effect.succeed(canonicalAdmissionUnavailable())))
      );
    }
    return this.dispatch(request, registered);
  }

  private connectionRequest(
    input: { request: Request; owns: (user: string) => boolean },
    path: string,
    command: string
  ): Option.Option<Promise<Response>> {
    const unit = { ...input, storage: this.ctx.storage, environment: this.env };
    if (path === connectionCallbackPath || Option.isSome(connectionBrowserTransport(path))) {
      return Option.some(
        this.runtime.runPromise(
          nativeConnectionBrowser({ unit, adapters: this.connectionAdapters() })
        )
      );
    }
    return command === "POST /work/connection-synchronization"
      ? Option.some(this.runtime.runPromise(runConnectionWork(unit, this.connectionAdapters())))
      : Option.none();
  }
  private enrollmentRequest(
    request: Request,
    owns: (id: string) => boolean
  ): Option.Option<Promise<Response>> {
    const path = new URL(request.url).pathname;
    const command = request.method + " " + path;
    if (
      ["POST /billing/registration-outcome", "POST /billing/registration-cancel"].includes(command)
    ) {
      return Option.some(
        this.runtime.runPromise(
          answerRegistration(request, owns).pipe(
            Effect.catchCause(() => Effect.succeed(canonicalAdmissionUnavailable()))
          )
        )
      );
    }
    if (Option.isSome(paymentEnrollmentTransport(path))) {
      const work = this.runtime.runPromise(
        handleLocalEnrollment(request, { env: this.env, storage: this.ctx.storage }, owns).pipe(
          Effect.catchCause(() => Effect.succeed(canonicalAdmissionUnavailable()))
        )
      );
      if (command.endsWith("/submit")) {
        this.ctx.waitUntil(work.then((response) => (response.ok ? this.alarm() : undefined)));
      }
      return Option.some(work);
    }
    return Option.none();
  }
  private dispatch(request: Request, registered: boolean): Promise<Response> {
    const path = new URL(request.url).pathname;
    const command = request.method + " " + path;
    const owns = (userId: string): boolean => registered && this.owns(userId);
    const connection = this.connectionRequest({ request, owns }, path, command);
    if (Option.isSome(connection)) return connection.value;
    const billing = this.enrollmentRequest(request, owns);
    if (Option.isSome(billing)) return billing.value;
    const identity = this.identityRequest(request, owns);
    if (Option.isSome(identity)) return identity.value;
    const credential = this.credentialRequest(request, path, owns);
    if (Option.isSome(credential)) return credential.value;
    const browser = this.browserRequest(request, command, owns);
    if (Option.isSome(browser)) return browser.value;
    const operation = canonicalOperation({ method: request.method, path });
    const mutation = Option.flatMap(operation, (selected) =>
      this.mutation(request, owns, selected)
    );
    if (Option.isSome(mutation)) return this.runtime.runPromise(mutation.value);
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
