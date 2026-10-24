import { Effect, Option } from "effect";
import type { PlatformMaintenanceInput } from "../contract";
import {
  type AlertSignal,
  type CapabilityProbe,
  type OperationalHealthEnvironment,
  QueueKind,
  WorkKind,
} from "../operational-health/contract";
import {
  inspectOperationalCapabilities,
  observeOperationalHealth,
  operationalSeverity,
} from "../operational-health/operations";

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
const reportOperationalSignals = (
  environment: PlatformMaintenanceInput,
  signals: ReadonlyArray<AlertSignal>
): Effect.Effect<void, void> =>
  Effect.forEach(
    signals,
    (signal) => {
      const severity = operationalSeverity(signal);
      const observation = {
        ...signal,
        severity,
        message: `fidy.operational component=${signal.component} operation=${signal.operation} state=${signal.state} severity=${severity}`,
      };
      return severity === "none" ? Effect.logInfo(observation) : Effect.logWarning(observation);
    },
    { discard: true }
  ).pipe(Effect.andThen(reportInspectionCoverage(environment, signals)));

const reportInspectionCoverage = (
  environment: PlatformMaintenanceInput,
  signals: ReadonlyArray<AlertSignal>
): Effect.Effect<void> => {
  const proactivityEnabled =
    environment.WEEKLY_SUMMARY_ENABLED === "enabled" ||
    environment.PROACTIVITY_ENABLED === "enabled";
  const expected: ReadonlyArray<AlertSignal["operation"]> = [
    ...WorkKind.literals.filter((owner) => owner !== "proactivity" || proactivityEnabled),
    ...QueueKind.literals.filter((owner) => owner !== "proactivityQueue" || proactivityEnabled),
    "whatsapp",
    "deadLetters",
    "retention",
    "d1",
    "requiredBindings",
    "coordination",
    "providerConfig",
  ];
  const observed = new Set(signals.map((signal) => signal.operation));
  const state = expected.every((owner) => observed.has(owner)) ? "complete" : "incomplete";
  return Effect.logInfo({
    component: "inspection-coverage",
    operation: "ownerInspections",
    state,
    message: `fidy.operational component=inspection-coverage operation=ownerInspections state=${state}`,
  });
};

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
      }).pipe(Effect.map((signals): ReadonlyArray<AlertSignal> => [...signals, ...capabilities]));

/** Probe independent capabilities before D1-backed inspection; outages still emit independent closed platform observations. */
export const inspectScheduledHealth = (
  environment: PlatformMaintenanceInput
): Effect.Effect<void, void> =>
  !Option.contains(environment.ASYNC_HEALTH_ENABLED, "enabled")
    ? Effect.void
    : inspectOperationalCapabilities({
        d1: environment.DB,
        coordinator: environment.USER_TRANSACTION_COORDINATOR,
        requiredBindings: requiredBindings(environment),
        providerConfigured: providerConfigured(environment),
      }).pipe(
        Effect.flatMap((capabilities) => scheduledSignals(environment, capabilities)),
        Effect.flatMap((signals) => reportOperationalSignals(environment, signals))
      );
