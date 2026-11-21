import {
  type ProactivityWorkObservations,
  proactivityObservationLimit,
} from "../../insights/contract";
import {
  type AlertSignal,
  CanaryPayload,
  type OperationalSeverity,
  type OperationalSignal,
  type PendingSignal,
} from "./contract";
import { inspectQueue, inspectWorkflow } from "./internal/health-inspection";
import { Effect, Exit, Option, Schema } from "effect";
import { WorkflowStatus, periodMs, staleMs } from "./internal/canary";

const validateCanary = (payload: unknown, now: number): Effect.Effect<CanaryPayload> =>
  Effect.suspend(() => {
    const decoded = Schema.decodeUnknownOption(CanaryPayload)(payload);

    return Option.isSome(decoded) &&
      decoded.value.sentAtMs <= now &&
      now - decoded.value.sentAtMs <= staleMs
      ? Effect.succeed(decoded.value)
      : Effect.die(new Error("Invalid operational canary"));
  });

export const receiveCanary = (
  input: Readonly<{
    workflow: Readonly<{
      create: (input: { id: string; params: CanaryPayload }) => Promise<unknown>;
      get: (id: string) => Promise<{ status: () => Promise<unknown> }>;
    }>;
    payload: unknown;
    now: number;
  }>
): Promise<void> =>
  Effect.runPromise(
    Effect.gen(function* () {
      const decoded = yield* validateCanary(input.payload, input.now);
      const id = `operational-canary-${Math.floor(decoded.sentAtMs / periodMs)}`;

      const created = yield* Effect.exit(
        Effect.tryPromise(() => input.workflow.create({ id, params: decoded }))
      );

      if (Exit.isFailure(created)) {
        const instance = yield* Effect.tryPromise(() => input.workflow.get(id)).pipe(
          Effect.catch(() => Effect.failCause(created.cause))
        );

        const status = yield* Effect.tryPromise(() => instance.status()).pipe(
          Effect.flatMap(Schema.decodeUnknownEffect(WorkflowStatus))
        );

        if (
          status.status === "errored" ||
          status.status === "terminated" ||
          status.status === "unknown"
        ) {
          return yield* Effect.failCause(created.cause);
        }
      }
    })
  );

export const completeCanary = ({
  payload,
  now,
}: Readonly<{ payload: unknown; now: number }>): Promise<void> =>
  Effect.runPromise(Effect.asVoid(validateCanary(payload, now)));

export const sendCanary = ({
  queue,
  now,
  signal,
}: Readonly<{
  queue: Pick<Queue, "send">;
  now: number;
  signal: AbortSignal;
}>): Promise<void> => {
  const sentAtMs = Math.floor(now / periodMs) * periodMs;

  if (now - sentAtMs >= minuteMs) return Promise.resolve();

  return Effect.runPromise(
    Effect.tryPromise(() => queue.send({ version: 1, sentAtMs } satisfies CanaryPayload)).pipe(
      Effect.timeout("2 seconds"),
      Effect.asVoid
    ),
    { signal }
  );
};

const minuteMs = 60_000;

const warningAgeMs = 120_000;

const criticalAgeMs = 600_000;

const rejectedEmailWarningCount = 5;

const retentionWarningAgeMs = 3_600_000;

const retentionCriticalAgeMs = 86_400_000;

const queueWarningCount = 100;

const queueCriticalCount = 1_000;

const rejectedEmailWarning = (signal: PendingSignal): boolean =>
  (signal.operation === "browserPairing" || signal.operation === "emailReplacement") &&
  signal.sampledRejectedEmailWork >= rejectedEmailWarningCount;

const pendingSeverity = (signal: PendingSignal): OperationalSeverity => {
  if (
    signal.oldestPendingAgeMilliseconds >= criticalAgeMs ||
    signal.expiredUndelivered > 0 ||
    (signal.operation !== "forwardedEmail" && signal.failedWorkflows > 0)
  ) {
    return "critical";
  }

  return signal.oldestPendingAgeMilliseconds >= warningAgeMs ||
    signal.unavailableWorkflows > 0 ||
    rejectedEmailWarning(signal)
    ? "warning"
    : "none";
};

const whatsappSeverity = (
  signal: Extract<OperationalSignal, { operation: "whatsapp"; state: "healthy" | "attention" }>
): OperationalSeverity => {
  if (
    signal.sampledFailed > 0 ||
    signal.overdueCleanup > 0 ||
    signal.oldestPendingAgeMilliseconds >= criticalAgeMs
  ) {
    return "critical";
  }

  return signal.oldestPendingAgeMilliseconds >= warningAgeMs ? "warning" : "none";
};

const queueSeverity = (
  signal: Extract<OperationalSignal, { backlogCount: number }>
): OperationalSeverity => {
  if (signal.operation === "deadLetters") return signal.backlogCount > 0 ? "critical" : "none";

  if (signal.backlogCount >= queueCriticalCount) return "critical";

  return signal.backlogCount >= queueWarningCount ? "warning" : "none";
};

const retentionSeverity = (age: number): OperationalSeverity => {
  if (age >= retentionCriticalAgeMs) return "critical";

  return age >= retentionWarningAgeMs ? "warning" : "none";
};

export const operationalSeverity = (signal: AlertSignal): OperationalSeverity => {
  if (signal.state === "unavailable") return "warning";

  if (signal.component === "capability") return "none";

  if ("backlogCount" in signal) return queueSeverity(signal);

  if (signal.operation === "retention") {
    return retentionSeverity(signal.oldestOverdueAgeMilliseconds);
  }

  if (signal.operation === "whatsapp") return whatsappSeverity(signal);

  return pendingSeverity(signal);
};

export const logOperationalSignal = Effect.fn(function* (signal: OperationalSignal) {
  const severity = operationalSeverity(signal);

  const observation = {
    ...signal,
    severity,
    message: `fidy.operational component=${signal.component} operation=${signal.operation} state=${signal.state} severity=${severity}`,
  };

  yield* severity === "none" ? Effect.logInfo(observation) : Effect.logWarning(observation);
});

const logRequiredBindings = Effect.fnUntraced(function* (healthy: boolean) {
  const state = healthy ? "healthy" : "unavailable";
  const message = `fidy.operational component=capability operation=requiredBindings state=${state} severity=${healthy ? "none" : "critical"}`;

  if (!healthy) {
    yield* Effect.logWarning({ message });

    return yield* Effect.fail("missing_proactivity_bindings" as const);
  }

  yield* Effect.logInfo({ message });
});

export const inspectNativeQueues = Effect.fn(function* (
  environment: Partial<
    Readonly<{
      ASYNC_HEALTH_ENABLED: string;
      ASYNC_DEAD_LETTERS: Pick<Queue, "metrics">;
      BROWSER_PAIRING_EMAIL_QUEUE: Pick<Queue, "metrics">;
      FORWARDED_EMAIL_QUEUE: Pick<Queue, "metrics">;
      BILLING_COLLECTION_QUEUE: Pick<Queue, "metrics">;
      STATEMENT_EXTRACTION_QUEUE: Pick<Queue, "metrics">;
      HOSTED_WHATSAPP_QUEUE: Pick<Queue, "metrics">;
      WEEKLY_DELIVERY_QUEUE: Pick<Queue, "metrics">;
      WEEKLY_DELIVERY_WORKFLOW: Pick<Workflow, "get">;
      PROACTIVITY_ENABLED: string;
      WEEKLY_SUMMARY_ENABLED: string;
    }>
  >
) {
  if (environment.ASYNC_HEALTH_ENABLED !== "enabled") return;

  const proactivity =
    environment.PROACTIVITY_ENABLED === "enabled" ||
    environment.WEEKLY_SUMMARY_ENABLED === "enabled";

  const baseQueues = [
    ["deadLetters", environment.ASYNC_DEAD_LETTERS],
    ["browserPairingQueue", environment.BROWSER_PAIRING_EMAIL_QUEUE],
    ["forwardedEmailQueue", environment.FORWARDED_EMAIL_QUEUE],
    ["billingQueue", environment.BILLING_COLLECTION_QUEUE],
    ["statementQueue", environment.STATEMENT_EXTRACTION_QUEUE],
    ["whatsappQueue", environment.HOSTED_WHATSAPP_QUEUE],
  ] as const;

  const queues = proactivity
    ? [...baseQueues, ["proactivityQueue", environment.WEEKLY_DELIVERY_QUEUE] as const]
    : baseQueues;

  yield* Effect.forEach(
    queues,
    ([operation, binding]) =>
      Effect.gen(function* () {
        const signal = yield* inspectQueue({ operation, queue: Option.fromUndefinedOr(binding) });
        yield* logOperationalSignal(signal);
      }),
    { concurrency: 4, discard: true }
  );

  const healthy =
    !proactivity ||
    (environment.WEEKLY_DELIVERY_QUEUE !== undefined &&
      environment.WEEKLY_DELIVERY_WORKFLOW !== undefined);

  yield* logRequiredBindings(healthy);
});

const pendingStaleMs = 120000;

export const observeNativePending = Effect.fn(function* (
  rows: ProactivityWorkObservations,
  workflow: Parameters<typeof inspectWorkflow>[0],
  now: number
) {
  const states = yield* Effect.forEach(
    rows.filter((row) => now - row.created >= pendingStaleMs),
    (row) => inspectWorkflow(workflow, row.id),
    { concurrency: 2 }
  );

  const failedWorkflows = states.filter((state) => state === "failed").length,
    unavailableWorkflows = states.filter((state) => state === "unavailable").length;

  const oldestPendingAgeMilliseconds = Math.max(0, ...rows.map((row) => now - row.created));

  const expiredUndelivered = rows.filter((row) =>
    Option.exists(row.deadline, (deadline) => deadline <= now)
  ).length;

  yield* logOperationalSignal({
    component: "async-health",
    operation: "proactivity",
    state:
      oldestPendingAgeMilliseconds >= pendingStaleMs ||
      expiredUndelivered > 0 ||
      failedWorkflows > 0 ||
      unavailableWorkflows > 0
        ? "attention"
        : "healthy",
    sampledPending: rows.length,
    sampleLimited: rows.length === proactivityObservationLimit,
    oldestPendingAgeMilliseconds,
    expiredUndelivered,
    failedWorkflows,
    unavailableWorkflows,
    sampledRejectedEmailWork: 0,
    rejectionSampleLimited: false,
  });
});
