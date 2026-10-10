import { EmailAddress } from "../../../src/core/email-authentication/contract";
import { Clock, Effect, Option, Schema } from "effect";
import type { PlatformMaintenanceInput } from "../contract";
import {
  type AlertSignal,
  type CanaryHealth,
  type CapabilityProbe,
  type EventMetricSignal,
  type OperationalHealthEnvironment,
  type OperationalSignal,
  WorkKind,
} from "../operational-health/contract";
import {
  decideOperationalAlerts,
  inspectOperationalCapabilities,
  observeOperationalEventMetrics,
  observeOperationalHealth,
  readCanaryHealth,
  recordOperationalHealth,
  runOperationalAlerts,
} from "../operational-health/operations";
import { sendOperatorEmail } from "../operational-health/runtime";

const deliverOperationalSignals = (
  environment: PlatformMaintenanceInput,
  signals: ReadonlyArray<OperationalSignal | EventMetricSignal | CanaryHealth | CapabilityProbe>,
  now: number
): Effect.Effect<void, void> =>
  Effect.tryPromise({
    try: (signal) => {
      const recipient = Option.flatMap(
        environment.OPERATOR_ALERT_EMAIL,
        Schema.decodeUnknownOption(EmailAddress)
      );
      if (Option.isNone(recipient) || Option.isNone(environment.RESEND_API_KEY)) {
        throw new Error("Operator email configuration unavailable");
      }
      const to = recipient.value;
      const apiKey = environment.RESEND_API_KEY.value;
      return runOperationalAlerts({
        db: environment.DB,
        outage: Option.map(environment.STATEMENT_STAGING_BUCKET, (bucket) => ({
          bucket,
          release: environment.RELEASE_GIT_SHA,
          inspection: d1Inspection(signals),
        })),
        now,
        alerts: decideOperationalAlerts(signals),
        signal,
        send: (alert, idempotencyKey, delivery) =>
          sendOperatorEmail({
            alert,
            idempotencyKey,
            to,
            apiKey,
            release: Option.getOrElse(delivery.release, () => environment.RELEASE_GIT_SHA),
            signal: delivery.signal,
            phase: delivery.phase,
          }),
      });
    },
    catch: () => undefined,
  });

const operationalWorkQueues = (
  environment: PlatformMaintenanceInput
): OperationalHealthEnvironment["workQueues"] => ({
  ...(Option.isSome(environment.BROWSER_PAIRING_EMAIL_QUEUE) && {
    browserPairingQueue: environment.BROWSER_PAIRING_EMAIL_QUEUE.value,
  }),
  ...(Option.isSome(environment.EMAIL_REPLACEMENT_HEALTH_QUEUE) && {
    emailReplacementQueue: environment.EMAIL_REPLACEMENT_HEALTH_QUEUE.value,
  }),
  ...(Option.isSome(environment.BILLING_COLLECTION_QUEUE) && {
    billingQueue: environment.BILLING_COLLECTION_QUEUE.value,
  }),
  ...(Option.isSome(environment.STATEMENT_EXTRACTION_QUEUE) && {
    statementQueue: environment.STATEMENT_EXTRACTION_QUEUE.value,
  }),
  ...(Option.isSome(environment.FORWARDED_EMAIL_QUEUE) && {
    forwardedEmailQueue: environment.FORWARDED_EMAIL_QUEUE.value,
  }),
  ...(environment.WEEKLY_DELIVERY_QUEUE !== undefined && {
    proactivityQueue: environment.WEEKLY_DELIVERY_QUEUE,
  }),
  ...(Option.isSome(environment.HOSTED_WHATSAPP_QUEUE) && {
    whatsappQueue: environment.HOSTED_WHATSAPP_QUEUE.value,
  }),
});

const providerConfigured = (environment: PlatformMaintenanceInput): boolean =>
  [
    environment.KAPSO_API_KEY,
    environment.KAPSO_WEBHOOK_SECRET,
    Option.getOrElse(environment.RESEND_API_KEY, () => ""),
    environment.HOSTED_AI_MODEL,
    environment.WOMPI_ENVIRONMENT,
    environment.WOMPI_PUBLIC_KEY,
    environment.WOMPI_PRIVATE_KEY,
    environment.WOMPI_INTEGRITY_SECRET,
    Option.getOrElse(environment.WOMPI_EVENT_SECRET, () => ""),
  ].every((value) => typeof value === "string" && value.trim().length > 0);

const requiredBindings = (environment: PlatformMaintenanceInput): ReadonlyArray<boolean> =>
  [
    Option.fromUndefinedOr(environment.DB),
    Option.fromUndefinedOr(environment.AI),
    Option.fromUndefinedOr(environment.USER_TRANSACTION_COORDINATOR),
    environment.ASYNC_DEAD_LETTERS,
    environment.OPERATIONAL_CANARY_QUEUE,
    environment.OPERATIONAL_CANARY_WORKFLOW,
    environment.EMAIL_BUCKET,
    environment.STATEMENT_STAGING_BUCKET,
    environment.STATEMENT_EXTRACTION_QUEUE,
    environment.STATEMENT_EXTRACTION_WORKFLOW,
    environment.BROWSER_PAIRING_EMAIL_QUEUE,
    environment.BROWSER_PAIRING_EMAIL_WORKFLOW,
    environment.EMAIL_REPLACEMENT_QUEUE,
    environment.EMAIL_REPLACEMENT_WORKFLOW,
    environment.BILLING_COLLECTION_QUEUE,
    environment.BILLING_COLLECTION_WORKFLOW,
    environment.HOSTED_WHATSAPP_QUEUE,
    environment.FORWARDED_EMAIL_QUEUE,
    environment.EMAIL_REPLACEMENT_HEALTH_QUEUE,
    ...(environment.WEEKLY_SUMMARY_ENABLED === "enabled" ||
    environment.PROACTIVITY_ENABLED === "enabled"
      ? [
          Option.fromUndefinedOr(environment.WEEKLY_DELIVERY_QUEUE),
          Option.fromUndefinedOr(environment.WEEKLY_DELIVERY_WORKFLOW),
        ]
      : []),
  ].map((binding) => Option.isSome<unknown>(binding));

const operationalWorkflows = (
  environment: PlatformMaintenanceInput
): OperationalHealthEnvironment["workflows"] => ({
  ...(Option.isSome(environment.STATEMENT_EXTRACTION_WORKFLOW) && {
    statement: environment.STATEMENT_EXTRACTION_WORKFLOW.value,
  }),
  ...(Option.isSome(environment.BROWSER_PAIRING_EMAIL_WORKFLOW) && {
    browserPairing: environment.BROWSER_PAIRING_EMAIL_WORKFLOW.value,
  }),
  ...(Option.isSome(environment.EMAIL_REPLACEMENT_WORKFLOW) && {
    emailReplacement: environment.EMAIL_REPLACEMENT_WORKFLOW.value,
  }),
  ...(environment.WEEKLY_DELIVERY_WORKFLOW !== undefined && {
    proactivity: environment.WEEKLY_DELIVERY_WORKFLOW,
  }),
  ...(Option.isSome(environment.BILLING_COLLECTION_WORKFLOW) && {
    billing: environment.BILLING_COLLECTION_WORKFLOW.value,
  }),
});

const d1Unavailable = (signals: ReadonlyArray<AlertSignal>): boolean =>
  signals.some((signal) => signal.operation === "d1" && signal.state === "unavailable");
const d1Inspection = (
  signals: ReadonlyArray<AlertSignal>
): "healthy" | "unavailable" | "unknown" => {
  if (d1Unavailable(signals)) return "unavailable";
  const unknown = signals.some(
    (signal) =>
      signal.state === "unavailable" &&
      (WorkKind.literals.some((owner) => owner === signal.operation) ||
        signal.operation === "whatsapp" ||
        signal.operation === "retention" ||
        signal.operation === "workflowFailures")
  );
  return unknown ? "unknown" : "healthy";
};
const retainOperationalSignals = (
  environment: PlatformMaintenanceInput,
  signals: ReadonlyArray<AlertSignal>
): Effect.Effect<void> =>
  d1Unavailable(signals)
    ? Effect.void
    : Effect.flatMap(Clock.currentTimeMillis, (observedAtMs) =>
        Effect.tryPromise({
          try: () => recordOperationalHealth({ db: environment.DB, signals, observedAtMs }),
          catch: () => undefined,
        }).pipe(
          Effect.timeout("2 seconds"),
          Effect.orElseSucceed(() => undefined)
        )
      );

const reportOperationalSignals = (
  environment: PlatformMaintenanceInput,
  signals: ReadonlyArray<AlertSignal>,
  observedAtMs: number
): Effect.Effect<void, void> =>
  Effect.forEach(
    signals,
    (signal) => (signal.state === "healthy" ? Effect.logInfo(signal) : Effect.logWarning(signal)),
    { discard: true }
  ).pipe(
    Effect.andThen(retainOperationalSignals(environment, signals)),
    Effect.andThen(deliverOperationalSignals(environment, signals, observedAtMs))
  );

const observeAdditionalSignals = (
  environment: PlatformMaintenanceInput,
  signals: ReadonlyArray<OperationalSignal>
): Effect.Effect<ReadonlyArray<OperationalSignal | EventMetricSignal | CanaryHealth>, void> =>
  Effect.flatMap(Clock.currentTimeMillis, (now) =>
    observeOperationalEventMetrics({ db: environment.DB, now }).pipe(
      Effect.flatMap((events) =>
        Effect.tryPromise({
          try: () => readCanaryHealth({ db: environment.DB, now }),
          catch: () => undefined,
        }).pipe(
          Effect.map(
            (canaries): ReadonlyArray<OperationalSignal | EventMetricSignal | CanaryHealth> => [
              ...signals,
              ...events,
              ...canaries,
            ]
          )
        )
      )
    )
  );

const scheduledSignals = (
  environment: PlatformMaintenanceInput,
  capabilities: ReadonlyArray<CapabilityProbe>
): Effect.Effect<ReadonlyArray<AlertSignal>, void> =>
  d1Unavailable(capabilities)
    ? Effect.succeed(capabilities)
    : observeOperationalHealth({
        DB: environment.DB,
        proactivity: {
          weeklyEnabled: environment.WEEKLY_SUMMARY_ENABLED === "enabled",
          proactivityEnabled: environment.PROACTIVITY_ENABLED === "enabled",
        },
        deadLetters: environment.ASYNC_DEAD_LETTERS,
        workQueues: operationalWorkQueues(environment),
        workflows: operationalWorkflows(environment),
      }).pipe(
        Effect.flatMap((signals) =>
          observeAdditionalSignals(environment, signals).pipe(
            Effect.timeout("2 seconds"),
            Effect.orElseSucceed((): ReadonlyArray<OperationalSignal | EventMetricSignal> => [
              ...signals,
              {
                component: "workflow-execution",
                operation: "workflowFailures",
                state: "unavailable",
              },
            ])
          )
        ),
        Effect.map((signals): ReadonlyArray<AlertSignal> => [...signals, ...capabilities])
      );

/** Probe independent capabilities before D1-backed inspection; outages still reach durable operator delivery. */
export const inspectScheduledHealth = (
  environment: PlatformMaintenanceInput
): Effect.Effect<void, void> =>
  !Option.contains(environment.ASYNC_HEALTH_ENABLED, "enabled")
    ? Effect.void
    : Effect.flatMap(Clock.currentTimeMillis, (observedAtMs) =>
        inspectOperationalCapabilities({
          d1: environment.DB,
          coordinator: environment.USER_TRANSACTION_COORDINATOR,
          requiredBindings: requiredBindings(environment),
          providerConfigured: providerConfigured(environment),
        }).pipe(
          Effect.flatMap((capabilities) => scheduledSignals(environment, capabilities)),
          Effect.flatMap((signals) => reportOperationalSignals(environment, signals, observedAtMs))
        )
      );
