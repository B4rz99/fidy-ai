import { betaUserUrl } from "../beta-pro/contract";
import { runBetaUserCommand } from "../beta-pro/operations";
import {
  logOperationalSignal,
  observeNativePending,
} from "../runtime/operational-health/operations";
import { HostedPauseNotice } from "../insights/contract";
import { localProactivityObservations, nativePauseNotice } from "../insights/operations";
import { BudgetThresholdEvaluation } from "../budgets/contract";
import {
  backgroundWorkAllowed,
  closedHostEnvironment,
  isPerformanceEvidence,
} from "../release-isolation/operations";
import type { AcceptanceWindowBindings } from "../release-isolation/contract";
import {
  cloudflareWorkerTelemetry,
  observeWorkerExecution,
  workerRelease,
} from "../runtime/telemetry/operations";
import { verifyReleaseTransaction } from "../storage-bootstrap/operations";
import { handleLocalProcessingConsent } from "../consent/runtime";
import { processingConsentTransport } from "../../src/shell/processing-consent/runtime";
import { recoverLocalAudit, repairLocalAuditAlarm } from "../audit/operations";
import { inspectUncertainty } from "./internal/uncertainty";
import { pendingExecutionRecoveryMs } from "../agent/contract";
import {
  nativeReminderActivity,
  recoverLocalReminders,
  repairLocalReminderAlarm,
} from "../insights/runtime";
import type { NativeReminderEnvironment } from "../insights/contract";
import {
  acceptLocalHostedText,
  admitLocalHostedDocument,
  handleLocalHosted,
  isLocalHostedPath,
  offerLocalHostedReply,
  recoverLocalHosted,
  repairLocalHostedAlarm,
} from "../agent/runtime";
import { drainLocalUser, keepErasedStoreEmpty, purgeLocalUser } from "./internal/erasure-purge";
import { confirmHandoffUrl, localDrainUrl, localPurgeUrl } from "../erasure-store/contract";
import {
  confirmErasureHandoff,
  offerErasureHandoff,
  repairErasureHandoff,
} from "./internal/erasure-handoff";
import { requestLocalErasure } from "./internal/erasure-request";
import { HttpClient } from "effect/http";
import {
  Cause,
  Clock,
  Context,
  Effect,
  Layer,
  ManagedRuntime,
  Option,
  Result,
  Schema,
} from "effect";
import { OutboundHttpLive } from "../outbound-http/runtime";
import {
  type LocalIngestionEnvironment,
  localDocumentUrl,
  localEmailUrl,
  localMediaUrl,
  localSampleReviewUrl,
} from "../ingestion/contract";
import {
  admitLocalDocument,
  admitLocalEmail,
  admitLocalMedia,
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
import { type McpResidency, localProtocolAdmission, mcpResidency } from "../mcp/runtime";
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
  expireSupportCases,
  localSupportApproval,
  recoverRotations,
  repairRecoveryAlarm,
  repairSupportRetention,
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
  voiceRefusalUrl,
} from "../whatsapp/contract";
import { nativeDeliveryRequest, nativeVoiceRefusal } from "../whatsapp/runtime";
import {
  type LocalBillingCollection,
  type LocalRefundWork,
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
  handleNativeRefund,
  handleNativeRefundWork,
  handleSourceCancellationWork,
  offerLocalBilling,
  recoverNativeRefunds,
  repairRefundAlarm,
} from "../subscription/runtime";
import {
  dispatchLocalForwarding,
  dispatchLocalReview,
  isLocalForwardingOperation,
  isLocalReviewOperation,
} from "../ingestion/operations";
import { dispatchLocalDashboard, isLocalDashboardOperation } from "../dashboard/operations";
import {
  dispatchLocalBudget,
  isLocalBudgetOperation,
  retainLocalBudgetThresholds,
} from "../budgets/operations";
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
import {
  observeStoreCheck,
  openSqliteStore,
  sqliteStoreLayer,
  storeReadiness,
} from "../runtime/sqlite/operations";

import { canonicalOperation } from "../routing/operations";
import {
  dispatchLocalTransaction,
  isLocalTransactionOperation,
  ownPerformanceEvidence,
  readScopedPrivacyPage,
} from "../transactions/operations";
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
  storeTransactionUrl,
} from "../runtime/sqlite/contract";

import { ownerCheckRequest, ownerCheckResponse } from "../maintenance/contract";

const uncertainCheckStatus = 503;

type UserStoreEnvironment = AcceptanceWindowBindings & {
  WHATSAPP_SANDBOX_PHONE_NUMBER_ID: string;
} & Partial<Readonly<{ SMOKE_PROOF: string; NATIVE_FIXTURE_SIGNING_KEY: string }>> &
  NativeReminderEnvironment &
  WompiBindings &
  LocalIngestionEnvironment &
  BancolombiaSandboxEnvironment &
  StoreReleaseEnvironment &
  Readonly<{
    ERASURE: DurableObjectNamespace;
    PRICING: DurableObjectNamespace;
    BROWSER_ORIGIN: string;
    RESEND_API_KEY: string;
    ASYNC_HEALTH_ENABLED: string;
    WEEKLY_DELIVERY_WORKFLOW: Workflow;
    OPENAI_API_KEY: string;
    HOSTED_AI_MODEL: string;
    BROWSER_PAIRING_EMAIL_QUEUE: Queue<typeof NativeLoginEmailWork.Type>;
    DIRECTORY: DurableObjectNamespace;
    USER_STORE: DurableObjectNamespace;
    MAINTENANCE: DurableObjectNamespace;
    CONNECTION_SYNCHRONIZATION_QUEUE: Queue<SynchronizationWork>;
    BILLING_COLLECTION_QUEUE: Queue<
      | typeof LocalSourceCancellationWork.Type
      | typeof LocalBillingCollection.Type
      | typeof LocalRefundWork.Type
    >;
  }>;

const isBrowserObservation = (command: string, request: Request): boolean =>
  ["GET /web/session/binding", "POST /web/session/logout"].includes(command) ||
  (command === "GET /user" && !request.headers.has("authorization"));

const alarmObservation = {
  telemetry: cloudflareWorkerTelemetry,
  operation: "worker.core.alarm",
} as const;

const completedAlarm = (summary: { failedFamilies: number }): Effect.Effect<void, Error> =>
  summary.failedFamilies > 0 ? Effect.fail(Error("User work discovery unavailable")) : Effect.void;

const isResponse = Schema.is(Schema.instanceOf(Response));

export class UserStore extends DurableObject<UserStoreEnvironment> {
  private browserEnvironment(request: Request): UserStoreEnvironment {
    return closedHostEnvironment({ request, environment: this.env, boundary: "core" });
  }
  protected connectionAdapters(): ConnectionAdapters {
    return sandboxConnectionAdapters({ environment: this.env, userId: this.ctx.id.name ?? "" });
  }
  private readonly runtime;
  private erased = false;
  private mcp?: McpResidency;
  private protocol(request: Request, owns: (id: string) => boolean): Promise<Response> {
    return this.runtime.runPromise(
      Effect.gen({ self: this }, function* () {
        const credential = yield* localOAuthAccessSubject(request, owns);

        if (Option.isNone(credential)) return denyMcpAccess();
        const admission = yield* localProtocolAdmission(request, credential.value);
        this.mcp ??= mcpResidency({
          userId: admission.userId,
          resolveCaller: (input) =>
            Effect.tryPromise({
              try: () => this.runtime.runPromise(resolveLocalOAuthCaller(input)),
              catch: () => new OAuthMcpCallerUnavailable(),
            }),
          enqueueCanonicalWork: ({ admission: call, signal }) =>
            Effect.gen({ self: this }, function* () {
              const prepared = yield* localOAuthCanonicalRequest(call, signal);

              if (isResponse(prepared)) return prepared;
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
    this.runtime = ManagedRuntime.make(
      Layer.mergeAll(
        Layer.succeed(HostedPauseNotice, nativePauseNotice),
        sqliteStoreLayer({
          storage: state.storage,
          owner: "user",
          ceilingBytes: env.SQLITE_STORE_CAPACITY_BYTES,
        }),
        Layer.succeed(BudgetThresholdEvaluation, (user, current) =>
          retainLocalBudgetThresholds(user, current, state.storage)
        )
      )
    );
    state.waitUntil(
      state.blockConcurrencyWhile(() =>
        this.runtime.runPromise(
          keepErasedStoreEmpty(Option.fromUndefinedOr(state.id.name), env.ERASURE).pipe(
            Effect.flatMap((erased) => {
              this.erased = erased;

              return erased
                ? Effect.void
                : openSqliteStore(userStoreHistory, env.CF_VERSION_METADATA.id);
            })
          )
        )
      )
    );
  }

  private connectionFamilies(
    current: number
  ): readonly [
    ReturnType<typeof expireConnectionAttempts>,
    ReturnType<typeof cleanConnectionGrants>,
    ReturnType<typeof offerConnectionWork>,
  ] {
    return [
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
    ];
  }

  private billingOffers(
    current: number
  ): readonly [
    ReturnType<typeof recoverNativeRefunds>,
    ReturnType<typeof offerDueSourceCancellations>,
  ] {
    return [
      recoverNativeRefunds({
        current,
        storage: this.ctx.storage,
        queue: this.env.BILLING_COLLECTION_QUEUE,
      }),
      offerDueSourceCancellations({
        current,
        storage: this.ctx.storage,
        queue: this.env.BILLING_COLLECTION_QUEUE,
      }),
    ] as const;
  }
  private checkWork(): Promise<void> {
    return this.runtime.runPromise(
      Effect.flatMap(Clock.currentTimeMillis, (current) => {
        const families = [
          offerErasureHandoff(this.ctx.storage, this.env.ERASURE, this.owns),
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
          recoverLocalReminders(this.env, this.ctx.storage, this.owns).pipe(
            Effect.mapError((cause) => new Cause.UnknownError(cause))
          ),
          recoverLocalRecurringSeries(current, this.ctx.storage, this.owns),
          recoverLocalReceipts(current, this.ctx.storage),
          recoverLocalAudit(current, this.ctx.storage, this.owns),
          expireSupportCases(current, this.ctx.storage, this.owns),
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
          ...this.connectionFamilies(current),
          recoverLocalPATExpiry(current, this.ctx.storage),
          ...this.billingOffers(current),
          offerLocalHostedReply(this.env, this.ctx.storage, this.owns).pipe(
            Effect.mapError((cause) => new Cause.UnknownError(cause))
          ),
        ] as const;

        type Work = (typeof families)[number];

        return recoverUserWork<Effect.Error<Work>, Effect.Services<Work>>({
          families,
          hosted: recoverLocalHosted(this.env, this.ctx.storage, this.owns).pipe(
            Effect.provideService(
              ConnectionSandboxAdmission,
              bancolombiaSandboxAdmission(this.env)
            ),
            Effect.mapError((cause) => new Cause.UnknownError(cause))
          ),
          timeoutMs: pendingExecutionRecoveryMs,
        });
      }).pipe(
        Effect.flatMap(completedAlarm),
        observeWorkerExecution({ ...alarmObservation, environment: workerRelease(this.env) })
      )
    );
  }

  override alarm(): Promise<void> {
    if (this.erased) return Promise.resolve();

    return this.runtime
      .runPromise(backgroundWorkAllowed(this.env))
      .then((allowed) =>
        allowed
          ? this.registration().then((registration) =>
              registration === "registered" ? this.checkWork() : undefined
            )
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

    const environment = this.browserEnvironment(request),
      directory = environment.DIRECTORY;

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
      [isLocalForwardingOperation, () => dispatchLocalForwarding({ ...unit, directory })],
      [isLocalSubscriptionRead, () => observeLocalSubscription(unit, environment)],
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
      ((request.method === "GET" && request.url === storeReadinessUrl) ||
        (request.method === "POST" && request.url === storeTransactionUrl)) &&
      this.ctx.id.equals(this.env.USER_STORE.idFromName(releaseProbeName))
    );
  }

  private readonly owns = (userId: string): boolean =>
    this.ctx.id.equals(this.env.USER_STORE.idFromName(userId));

  private registration(): Promise<Effect.Success<ReturnType<typeof observeUserRegistration>>> {
    return this.runtime.runPromise(
      observeUserRegistration(this.env.MAINTENANCE, this.owns, this.env)
    );
  }

  private erasedResponse(request: Request): Promise<Response> {
    if (request.url === betaUserUrl) return Promise.resolve(new Response(null, { status: 404 }));

    if (ownerCheckRequest(request)) return Promise.resolve(ownerCheckResponse());

    if (
      request.method === "POST" &&
      [statusDeliveryUrl, replyDeliveryUrl, settleUserBillingUrl].includes(request.url)
    ) {
      return Promise.resolve(new Response(null, { status: 204 }));
    }

    return Promise.resolve(new Response(null, { status: 401 }));
  }
  private erasureCommand(request: Request): Promise<Response> {
    const unit = { env: this.env, storage: this.ctx.storage, owns: this.owns };

    if (request.url === localPurgeUrl) {
      return this.runtime.runPromise(
        purgeLocalUser(request, unit, this.retireMcp(Option.none())).pipe(
          Effect.tap((reply) =>
            Effect.sync(() => {
              if (reply.ok) {
                this.erased = true;
                this.mcp = undefined;
              }
            })
          ),
          Effect.catchCause(() => Effect.succeed(new Response(null, { status: 503 })))
        )
      );
    }

    return this.runtime.runPromise(
      drainLocalUser(request, unit).pipe(
        Effect.catchCause(() => Effect.succeed(new Response(null, { status: 503 })))
      )
    );
  }
  private scopedErasureCommand(request: Request): Promise<Response> {
    if (this.env.NATIVE_STORAGE_ADMISSION === "closed" && !this.erased) {
      return this.registration().then((registration) =>
        registration === "registered"
          ? this.erasureCommand(request)
          : canonicalAdmissionUnavailable()
      );
    }

    return this.erasureCommand(request);
  }
  override fetch(request: Request): Promise<Response> {
    if (request.method === "POST" && [localDrainUrl, localPurgeUrl].includes(request.url)) {
      return this.scopedErasureCommand(request);
    }

    if (this.erased) return this.erasedResponse(request);

    if (this.isReleaseProbe(request)) {
      if (request.method === "POST") {
        return Promise.resolve(verifyReleaseTransaction(this.ctx.storage));
      }

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
        if (registration === "unavailable" && request.url === betaUserUrl) {
          return canonicalAdmissionUnavailable();
        }

        if (registration === "isolated") return canonicalAdmissionUnavailable();

        if (registration === "unavailable" && ownerCheckRequest(request)) {
          return new Response(null, { status: uncertainCheckStatus });
        }

        return this.registeredRequest(request, registration === "registered");
      },
      () => canonicalAdmissionUnavailable()
    );
  }

  private observePendingWork(remindersEnabled: { category: boolean; weekly: boolean }): void {
    if (
      this.env.ASYNC_HEALTH_ENABLED === "enabled" &&
      (remindersEnabled.weekly || remindersEnabled.category)
    ) {
      this.ctx.waitUntil(
        this.runtime.runPromise(
          Effect.gen({ self: this }, function* () {
            const now = yield* Clock.currentTimeMillis,
              rows = yield* localProactivityObservations(remindersEnabled);

            yield* observeNativePending(
              rows,
              Option.fromUndefinedOr(this.env.WEEKLY_DELIVERY_WORKFLOW),
              now
            );
          }).pipe(
            Effect.catchCause(() =>
              logOperationalSignal({
                component: "async-health",
                operation: "proactivity",
                state: "unavailable",
              })
            )
          )
        )
      );
    }
  }

  private inspectWork(sampleWork: boolean): Promise<Response> {
    const storage = this.ctx.storage;
    const ownsUser = this.owns;

    const remindersEnabled = {
      category: this.env.PROACTIVITY_ENABLED === "enabled",
      weekly: this.env.WEEKLY_SUMMARY_ENABLED === "enabled",
    };

    if (sampleWork) this.observePendingWork(remindersEnabled);
    const adapters = this.connectionAdapters();

    return this.runtime.runPromise(
      Effect.gen(function* () {
        const current = yield* Clock.currentTimeMillis;

        const inspections = yield* Effect.all(
          [
            repairErasureHandoff(storage),
            repairLoginAlarm(current, storage),
            repairLocalHostedAlarm(current, storage),
            repairLocalReminderAlarm(current, storage, remindersEnabled),
            repairReplacementAlarm(current, storage),
            repairRecoveryAlarm(current, storage),
            repairReceiptAlarm(current, storage),
            repairLocalAuditAlarm(current, storage),
            repairSupportRetention(storage),
            repairLocalIngestionAlarm(current, storage),
            checkConnectionAlarm(storage),
            repairConnectionRetention({ storage, adapters }),
            repairLocalPATExpiry(current, storage),
            repairCancellationAlarm(storage),
            billingWake(storage),
            repairRefundAlarm(storage),
            repairLocalRecurringAlarm(current, storage, ownsUser),
          ],
          { mode: "result", concurrency: 1 }
        );

        if (inspections.some(Result.isFailure)) {
          return new Response(null, { status: uncertainCheckStatus });
        }

        const response = ownerCheckResponse(
          inspections.some((result) => Result.isSuccess(result) && result.success)
        );

        response.headers.set("fidy-uncertain-sample-count", String(yield* inspectUncertainty));

        return response;
      }).pipe(
        observeStoreCheck({
          storage,
          history: userStoreHistory,
          release: this.env.CF_VERSION_METADATA.id,
        })
      )
    );
  }

  private inboxRequest(
    request: Request,
    owns: (id: string) => boolean
  ): Option.Option<Promise<Response>> {
    const unit = { request, env: this.env, owns, storage: this.ctx.storage };

    switch (request.url) {
      case voiceRefusalUrl:
        return Option.some(
          this.runtime.runPromise(
            Effect.scoped(
              Effect.flatMap(Layer.build(OutboundHttpLive), (clients) =>
                nativeVoiceRefusal({
                  request,
                  environment: this.env,
                  owns,
                  storage: this.ctx.storage,
                }).pipe(
                  Effect.provideService(
                    HttpClient.HttpClient,
                    Context.get(clients, HttpClient.HttpClient)
                  )
                )
              )
            ).pipe(Effect.catchCause(() => Effect.succeed(canonicalAdmissionUnavailable())))
          )
        );
      case localMediaUrl:
        return Option.some(
          this.runtime.runPromise(
            admitLocalMedia(unit).pipe(
              Effect.catchCause(() => Effect.succeed(canonicalAdmissionUnavailable()))
            )
          )
        );
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
      default:
        return Option.none();
    }
  }
  private ingestionRequest(
    request: Request,
    owns: (id: string) => boolean
  ): Option.Option<Promise<Response>> {
    const unit = { request, env: this.env, owns, storage: this.ctx.storage };

    switch (request.url) {
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
                admitLocalDocument(unit, admitLocalHostedDocument).pipe(
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
            origin: this.browserEnvironment(request).BROWSER_ORIGIN,
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
            origin: this.browserEnvironment(request).BROWSER_ORIGIN,
          })
        )
      );
    }

    return Option.none();
  }
  private privacyRequest(
    request: Request,
    command: string,
    owns: (id: string) => boolean
  ): Option.Option<Promise<Response>> {
    if (isPerformanceEvidence(request)) {
      const environment = this.browserEnvironment(request);

      return Option.some(
        this.runtime.runPromise(
          ownPerformanceEvidence(
            request,
            { ...environment, RELEASE_GIT_SHA: environment.RELEASE_GIT_SHA ?? "" },
            owns
          )
        )
      );
    }

    if (command === "POST /web/privacy/transactions") {
      return Option.some(
        this.runtime.runPromise(
          readScopedPrivacyPage(request, this.browserEnvironment(request).BROWSER_ORIGIN, owns)
        )
      );
    }

    if (command === "POST /web/privacy/erasure") {
      return Option.some(
        this.runtime.runPromise(
          requestLocalErasure({
            request,
            origin: this.browserEnvironment(request).BROWSER_ORIGIN,
            storage: this.ctx.storage,
            owns,
          }).pipe(
            Effect.tap((response) =>
              response.ok
                ? offerErasureHandoff(this.ctx.storage, this.env.ERASURE, owns).pipe(Effect.ignore)
                : Effect.void
            )
          )
        )
      );
    }

    if (Option.isSome(processingConsentTransport(new URL(request.url).pathname))) {
      return Option.some(
        this.runtime.runPromise(
          handleLocalProcessingConsent(
            request,
            this.browserEnvironment(request).BROWSER_ORIGIN,
            owns
          )
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
    const privacy = this.privacyRequest(request, command, owns);

    if (Option.isSome(privacy)) return privacy;

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
        localSupportApproval(request, owns, this.ctx.storage).pipe(
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
      if (request.url === confirmHandoffUrl) {
        return this.runtime.runPromise(
          confirmErasureHandoff(request, owns).pipe(
            Effect.catchCause(() => Effect.succeed(canonicalAdmissionUnavailable()))
          )
        );
      }

      const ingestion = this.inboxRequest(request, owns).pipe(
        Option.orElse(() => this.ingestionRequest(request, owns))
      );

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
          Effect.tap(() =>
            request.url === statusDeliveryUrl
              ? Effect.flatMap(Clock.currentTimeMillis, (now) =>
                  repairLocalReminderAlarm(now, this.ctx.storage, {
                    category: this.env.PROACTIVITY_ENABLED === "enabled",
                    weekly: this.env.WEEKLY_SUMMARY_ENABLED === "enabled",
                  })
                )
              : Effect.void
          ),
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

  private agentRequest(
    request: Request,
    owns: (id: string) => boolean
  ): Option.Option<Promise<Response>> {
    if (request.method !== "POST") return Option.none();

    if (request.url === "https://user.invalid/hosted-turn/whatsapp") {
      return Option.some(
        this.runtime.runPromise(
          acceptLocalHostedText(request, owns, { storage: this.ctx.storage, env: this.env })
        )
      );
    }

    if (isLocalHostedPath(new URL(request.url).pathname)) {
      return Option.some(
        this.runtime.runPromise(
          handleLocalHosted(request, owns, {
            env: this.browserEnvironment(request),
            storage: this.ctx.storage,
          }),
          { signal: request.signal }
        )
      );
    }

    if (request.url === "https://coordinator/proactivity-work") {
      return Option.some(
        this.runtime.runPromise(
          nativeReminderActivity(request, this.env, { owns, storage: this.ctx.storage }).pipe(
            Effect.catchCause(() => Effect.succeed(canonicalAdmissionUnavailable()))
          )
        )
      );
    }

    return Option.none();
  }

  private connectionRequest(
    input: { request: Request; owns: (user: string) => boolean },
    path: string,
    command: string
  ): Option.Option<Promise<Response>> {
    const unit = {
      ...input,
      storage: this.ctx.storage,
      environment: this.browserEnvironment(input.request),
    };

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

    if (command === "POST /beta-pro") {
      return Option.some(this.runtime.runPromise(runBetaUserCommand(request, owns)));
    }

    if (command === "POST /work/refund") {
      return Option.some(
        this.runtime.runPromise(
          handleNativeRefundWork(request, { owns, storage: this.ctx.storage, env: this.env }).pipe(
            Effect.catchCause(() => Effect.succeed(new Response(null, { status: 503 })))
          )
        )
      );
    }

    if (command === "POST /billing/refund-support") {
      return Option.some(
        this.runtime.runPromise(
          handleNativeRefund(request, {
            owns,
            storage: this.ctx.storage,
            environment: this.env.WOMPI_ENVIRONMENT,
          })
        )
      );
    }

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
        handleLocalEnrollment(
          request,
          { env: this.browserEnvironment(request), storage: this.ctx.storage },
          owns
        ).pipe(Effect.catchCause(() => Effect.succeed(canonicalAdmissionUnavailable())))
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

    const family = Option.orElse(this.agentRequest(request, owns), () =>
      this.connectionRequest({ request, owns }, path, command)
    );

    if (Option.isSome(family)) return family.value;
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
      return registered
        ? this.inspectWork(request.headers.get("fidy-workflow-sample") === "1")
        : Promise.resolve(ownerCheckResponse());
    }

    return Promise.resolve(new Response(null, { status: 404 }));
  }
}
