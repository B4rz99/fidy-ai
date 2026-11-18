import { reportWatchdog, runWatchdog } from "./internal/watchdog";
import type { SharedBindings } from "../storage-bootstrap/contract";
import {
  executeDueSchedule,
  handleLifetimeRegistration,
  lifetimeRequest,
  maintenanceStoreHistory,
} from "./operations";
import { DurableObject } from "cloudflare:workers";
import { createStoreRuntime, openSqliteStore, storeReadiness } from "../runtime/sqlite/operations";
import { type StoreReleaseEnvironment, storeReadinessUrl } from "../runtime/sqlite/contract";

import { makeBancolombiaSandboxCleanup } from "../bancolombia-authentication/runtime";
import { sweepProviderAuthentication } from "../provider-authentication/runtime";
import { sweepRecoveryEvidence } from "../recovery/runtime";
import { Clock, Effect, Option, Redacted } from "effect";
import { makeAuditRetention } from "../../src/shell/audit/runtime";
import {
  type CoreMaintenanceInput,
  EmailScheduleUnavailable,
  type ScheduledActivity,
  type ScheduledOperation,
  type ScheduledWorkFailed,
  maintenanceName,
  watchdogRequest,
} from "./contract";

import { sweepCanonicalAdmission } from "../canonical-admission/runtime";
import { sweepCommercialAllowances } from "../quotas/runtime";
import type { ForwardedEmailEnvironment } from "../ingestion/contract";
import { makePlatformMaintenance } from "../runtime/runtime";
import { makeAgentRetention } from "../agent/runtime";
import { sweepExpiredOpenAiAdmission } from "../ai/runtime";
import { recoverPendingDisclosures, sweepExpiredConsent } from "../consent/ingress/runtime";
import {
  dispatchEmailReplacement,
  reconcileEmailReplacement,
} from "../email-authentication/runtime";
import {
  dispatchRefunds,
  dispatchSubscriptionCancellations,
  dispatchVoidVerification,
} from "../subscription/runtime";
import {
  dispatchForwardedEmail,
  dispatchStatementExtraction,
  expireStatementReviewEvidence,
  reconcileStatementExtraction,
  statementRetention,
  sweepExpiredUploadAdmission,
  sweepForwardedEmail,
  sweepMediaSubmissions,
  sweepReviewDrafts,
} from "../ingestion/runtime";
import { sweepProactivityConsentOffers } from "../consent/runtime";
import { sweepExpiredPATPairings } from "../tokens/runtime";
import { sweepOAuthConfirmation } from "../oauth-confirmation/runtime";
import { recoverConnections } from "../connections/runtime";
import { advanceProactivityWork } from "../insights/runtime";
import { advanceRecurringWork } from "../recurring/runtime";
import { repairDashboardProjections } from "../transactions/runtime";
import { dispatchWhatsAppWork, sweepExpiredWhatsAppWindows } from "../whatsapp/runtime";

const activity = <E>(
  operation: ScheduledOperation,
  work: Effect.Effect<unknown, E>
): ScheduledActivity => ({ operation, work: work.pipe(Effect.mapError(() => undefined)) });

const emailActivities = (environment: CoreMaintenanceInput): ReadonlyArray<ScheduledActivity> => [
  activity(
    "emailReplacement.dispatch",
    Option.match(environment.EMAIL_REPLACEMENT_QUEUE, {
      onNone: () => Effect.void,
      onSome: (queue) =>
        dispatchEmailReplacement({
          DB: environment.DB,
          EMAIL_REPLACEMENT_QUEUE: queue,
          identity: Option.none(),
        }),
    })
  ),
  activity("emailReplacement.reconcile", reconcileEmailReplacement(environment.DB)),
];

const billingActivities = (environment: CoreMaintenanceInput): ReadonlyArray<ScheduledActivity> => [
  activity(
    "billing.cancellation.dispatch",
    Option.match(environment.BILLING_COLLECTION_QUEUE, {
      onNone: () => Effect.void,
      onSome: (queue) =>
        dispatchSubscriptionCancellations({ DB: environment.DB, BILLING_COLLECTION_QUEUE: queue }),
    })
  ),
  activity(
    "billing.refund.reconcile",
    Option.match(environment.BILLING_COLLECTION_QUEUE, {
      onNone: () => Effect.void,
      onSome: (queue) =>
        dispatchVoidVerification({ DB: environment.DB, BILLING_COLLECTION_QUEUE: queue }),
    })
  ),
  activity(
    "billing.refund.dispatch",
    Option.match(environment.BILLING_COLLECTION_QUEUE, {
      onNone: () => Effect.void,
      onSome: (queue) => dispatchRefunds({ DB: environment.DB, BILLING_COLLECTION_QUEUE: queue }),
    })
  ),
];

const channelActivities = (
  environment: CoreMaintenanceInput,
  nowEpochMs: number
): ReadonlyArray<ScheduledActivity> => [
  activity("consent.sweep", sweepExpiredConsent(environment.DB)()),
  activity("consent.proactivityOfferRetention", sweepProactivityConsentOffers(environment.DB)),
  activity(
    "consent.disclosureRecovery",
    recoverPendingDisclosures({
      db: environment.DB,
      apiKey: environment.KAPSO_API_KEY,
      sandboxPhoneNumberId: Option.fromNullishOr(environment.WHATSAPP_SANDBOX_PHONE_NUMBER_ID),
    })
  ),
  activity(
    "hostedTurn.whatsapp.dispatch",
    Option.match(environment.HOSTED_WHATSAPP_QUEUE, {
      onNone: () => Effect.void,
      onSome: (queue) => dispatchWhatsAppWork({ db: environment.DB, queue, userId: Option.none() }),
    })
  ),
  activity(
    "hostedTurn.whatsapp.windowSweep",
    sweepExpiredWhatsAppWindows({ db: environment.DB, now: nowEpochMs })
  ),
  activity("hostedTurn.sweep", makeAgentRetention({ db: environment.DB }).sweep(nowEpochMs)),
];

const stagingActivities = (
  environment: CoreMaintenanceInput,
  nowEpochMs: number
): ReadonlyArray<ScheduledActivity> => {
  const staging = Option.map(environment.STATEMENT_STAGING_BUCKET, (bucket) =>
    statementRetention({
      bucket,
      database: environment.DB,
      nowEpochMs: () => nowEpochMs,
    })
  );
  return [
    activity(
      "ingestion.submissionRetention",
      Option.match(staging, {
        onNone: () => Effect.void,
        onSome: (retention) => retention.expireSubmissions,
      })
    ),
    activity(
      "ingestion.stagingSweep",
      Option.match(staging, {
        onNone: () => Effect.void,
        onSome: (retention) => retention.sweepStaging,
      })
    ),
  ];
};

const admissionActivities = (
  environment: CoreMaintenanceInput,
  nowEpochMs: number
): ReadonlyArray<ScheduledActivity> => [
  activity(
    "ingestion.mediaRetention",
    sweepMediaSubmissions({ db: environment.DB, now: nowEpochMs })
  ),
  activity(
    "ingestion.uploadAdmissionSweep",
    sweepExpiredUploadAdmission({ db: environment.DB, now: nowEpochMs })
  ),
  activity(
    "agent.openAiAdmissionSweep",
    sweepExpiredOpenAiAdmission({ db: environment.DB, now: nowEpochMs })
  ),
  activity(
    "provider.authenticationRetention",
    sweepProviderAuthentication({ db: environment.DB, current: nowEpochMs })
  ),
  activity(
    "canonical.admissionRetention",
    sweepCanonicalAdmission({ db: environment.DB, current: nowEpochMs })
  ),
  activity(
    "oauth.confirmationRetention",
    sweepOAuthConfirmation({ db: environment.DB, current: nowEpochMs })
  ),
  activity(
    "quota.consumptionRetention",
    sweepCommercialAllowances({ db: environment.DB, current: nowEpochMs })
  ),
];

const statementActivities = (
  environment: CoreMaintenanceInput
): ReadonlyArray<ScheduledActivity> => [
  activity(
    "ingestion.reviewEvidenceExpiry",
    Option.match(environment.STATEMENT_STAGING_BUCKET, {
      onNone: () => Effect.void,
      onSome: () => expireStatementReviewEvidence({ DB: environment.DB }),
    })
  ),
  activity(
    "ingestion.statementReconcile",
    Option.match(environment.STATEMENT_EXTRACTION_WORKFLOW, {
      onNone: () => Effect.void,
      onSome: (workflow) =>
        reconcileStatementExtraction({
          userId: Option.none(),
          DB: environment.DB,
          STATEMENT_EXTRACTION_WORKFLOW: workflow,
          USER_TRANSACTION_COORDINATOR: environment.USER_TRANSACTION_COORDINATOR,
        }),
    })
  ),
  activity(
    "ingestion.statementDispatch",
    Option.match(environment.STATEMENT_EXTRACTION_QUEUE, {
      onNone: () => Effect.void,
      onSome: (queue) =>
        dispatchStatementExtraction({
          DB: environment.DB,
          STATEMENT_EXTRACTION_QUEUE: queue,
          STATEMENT_EXTRACTION_WORKFLOW: environment.STATEMENT_EXTRACTION_WORKFLOW,
        }),
    })
  ),
];

/**
 * Run one Core tick through published owner runtimes. Work starts at execution time, with one
 * shared decision instant for sweeps that accept it. Owners retain their own policy and authority;
 * independent failures are reported only after the remaining activities have been attempted.
 */
export const runCoreMaintenance = (
  input:
    | CoreMaintenanceInput
    | Readonly<{ environment: CoreMaintenanceInput; scheduledAtEpochMs: number }>
): Effect.Effect<void, ScheduledWorkFailed> =>
  Effect.gen(function* () {
    const nowEpochMs = yield* Clock.currentTimeMillis;
    const environment = "environment" in input ? input.environment : input;
    const platform = makePlatformMaintenance(environment);
    yield* executeDueSchedule({
      activities: [
        activity("async.health", platform.inspectHealth()),
        activity(
          "ingestion.reviewDraftExpiry",
          sweepReviewDrafts({ db: environment.DB, current: nowEpochMs })
        ),
        activity(
          "audit.retention",
          makeAuditRetention({ database: environment.DB }).sweep(nowEpochMs)
        ),
        activity("recovery.retention", sweepRecoveryEvidence({ db: environment.DB, nowEpochMs })),
        activity("operational.canary.publish", platform.publishCanary(nowEpochMs)),
        ...emailActivities(environment),
        ...billingActivities(environment),
        ...channelActivities(environment, nowEpochMs),
        activity("patPairing.sweep", sweepExpiredPATPairings(environment.DB)),
        activity("dashboard.projectionRepair", repairDashboardProjections(environment.DB)),
        activity("recurring.evaluate", advanceRecurringWork(environment)),
        activity("insights.weekly.dispatch", advanceProactivityWork(environment)),
        ...stagingActivities(environment, nowEpochMs),
        activity(
          "connections.recovery",
          recoverConnections({
            db: environment.DB,
            key: Option.map(
              Option.fromUndefinedOr(environment.BANCOLOMBIA_SANDBOX_GRANT_KEY),
              Redacted.make
            ),
            bank: makeBancolombiaSandboxCleanup(environment),
            scheduledAtEpochMs: "environment" in input ? input.scheduledAtEpochMs : nowEpochMs,
          })
        ),
        ...admissionActivities(environment, nowEpochMs),
        ...statementActivities(environment),
      ],
      nowEpochMs: "environment" in input ? input.scheduledAtEpochMs : nowEpochMs,
    });
  });

/** Attempt Email retention and delivery independently without widening the Email Worker's bindings. */
export const runEmailMaintenance = (
  input:
    | ForwardedEmailEnvironment
    | Readonly<{ environment: ForwardedEmailEnvironment; scheduledAtEpochMs: number }>
): Effect.Effect<void, EmailScheduleUnavailable> =>
  Effect.flatMap(Clock.currentTimeMillis, (nowEpochMs) => {
    const environment = "environment" in input ? input.environment : input;
    return executeDueSchedule({
      activities: [
        activity("forwarded-email.sweep", sweepForwardedEmail(environment)),
        activity("forwarded-email.dispatch", dispatchForwardedEmail(environment)),
      ],
      nowEpochMs: "environment" in input ? input.scheduledAtEpochMs : nowEpochMs,
    });
  }).pipe(Effect.mapError(() => new EmailScheduleUnavailable()));

type MaintenanceEnvironment = StoreReleaseEnvironment &
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
    if (this.env.RECOVERY_ISOLATION === "isolated") {
      return Promise.resolve(new Response(null, { status: 403 }));
    }
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
          Effect.tap(reportWatchdog),
          // Flush progress before a forced reset, inside the same tick deadline.
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
        // A transport ignoring cancellation can keep this incarnation resident indefinitely.
        if (this.pending.size > 0) this.ctx.abort("watchdog probe cleanup unavailable");
        this.sweeping = false;
      });
  }
  override fetch(request: Request): Promise<Response> {
    if (this.ctx.id.name !== maintenanceName) {
      return Promise.resolve(new Response(null, { status: 404 }));
    }
    if (watchdogRequest(request)) return this.watchdog(request);
    if (lifetimeRequest(request)) {
      return this.runtime.runPromise(
        handleLifetimeRegistration(request).pipe(
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
