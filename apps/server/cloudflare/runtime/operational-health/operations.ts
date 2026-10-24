import { inspectWhatsApp } from "../../whatsapp/operations";
import {
  CanaryPayload,
  type CapabilityProbe,
  type OperationalHealthEnvironment,
  type OperationalSignal,
  QueueKind,
  WorkKind,
  coordinatorProbeName,
} from "./contract";
import {
  inspectPending,
  inspectQueue,
  inspectRetention,
  unavailableSignal,
} from "./internal/health-inspection";
import { signalSeverity } from "./internal/alert-policy";
import { Clock, Effect, Exit, Option, Schema } from "effect";
import { WorkflowStatus, periodMs, staleMs } from "./internal/canary";

const Available = Schema.Struct({ usable: Schema.Literal(1) });
const probeUrl = "https://internal.invalid/operational/probe";
const probeSuccessStatus = 204;

const validateCanary = (payload: unknown, now: number): Effect.Effect<CanaryPayload> =>
  Effect.suspend(() => {
    const decoded = Schema.decodeUnknownOption(CanaryPayload)(payload);
    return Option.isSome(decoded) &&
      decoded.value.sentAtMs <= now &&
      now - decoded.value.sentAtMs <= staleMs
      ? Effect.succeed(decoded.value)
      : Effect.die(new Error("Invalid operational canary"));
  });

/** An actual Queue consumer, not queue.send(), proves Queue execution. */
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

/** Native WORKFLOW_SUCCESS, not instance creation, proves completion of this validated step. */
export const completeCanary = ({
  payload,
  now,
}: Readonly<{ payload: unknown; now: number }>): Promise<void> =>
  Effect.runPromise(Effect.asVoid(validateCanary(payload, now)));

/** Sending is not success; missing Workflows and Queue delivery remain visible until a real completion. */
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
  // Core ticks every minute; publish only in the first minute of each canary period.
  if (now - sentAtMs >= minuteMs) return Promise.resolve();
  return Effect.runPromise(
    Effect.tryPromise(() => queue.send({ version: 1, sentAtMs } satisfies CanaryPayload)).pipe(
      // Queue.send has no cancellation API. Stop waiting without retrying an ambiguous offer.
      Effect.timeout("2 seconds"),
      Effect.asVoid
    ),
    { signal }
  );
};

/**
 * Inspect a bounded oldest-work sample per owner and the dead-letter backlog. An unavailable
 * monitor reports its own closed signal without masking the other owners or changing domain work.
 * Workflow error messages and outputs are never retained. Counts are samples, not global totals.
 */
export const observeOperationalHealth = (
  environment: OperationalHealthEnvironment
): Effect.Effect<ReadonlyArray<OperationalSignal>> =>
  Effect.gen(function* () {
    const current = yield* Clock.currentTimeMillis;
    const signals = yield* Effect.forEach(
      WorkKind.literals.filter(
        (kind) =>
          kind !== "proactivity" ||
          environment.proactivity.weeklyEnabled === true ||
          environment.proactivity.proactivityEnabled === true
      ),
      (operation) =>
        inspectPending({ environment, operation, current }).pipe(
          Effect.timeout("3 seconds"),
          Effect.orElseSucceed((): OperationalSignal => unavailableSignal(operation))
        ),
      { concurrency: 2 }
    );
    const whatsapp = yield* inspectWhatsApp({ db: environment.DB, current }).pipe(
      Effect.timeout("3 seconds"),
      Effect.orElseSucceed((): OperationalSignal => unavailableSignal("whatsapp"))
    );
    const deadLetters = yield* inspectQueue({
      operation: "deadLetters",
      queue: environment.deadLetters,
    });
    const workQueues = yield* Effect.forEach(
      QueueKind.literals.filter(
        (kind) =>
          kind !== "proactivityQueue" ||
          environment.proactivity.weeklyEnabled === true ||
          environment.proactivity.proactivityEnabled === true
      ),
      (operation) =>
        inspectQueue({
          operation,
          queue: Option.fromUndefinedOr(environment.workQueues[operation]),
        }),
      { concurrency: 2 }
    );
    const retention = yield* inspectRetention({ db: environment.DB, now: current });
    return [...signals, whatsapp, deadLetters, ...workQueues, retention];
  });

/** Unavailable measurements and failed work never become healthy zeroes. */
export const operationalSeverity = signalSeverity;

/** Private readiness evidence; configuration means present, not that an external provider succeeded. */
export const inspectOperationalCapabilities = (
  input: Readonly<{
    d1: Readonly<{ prepare: (sql: string) => { first: () => Promise<unknown> } }>;
    coordinator: Readonly<{
      getByName: (name: string) => { fetch: (request: Request) => Promise<Response> };
    }>;
    requiredBindings: ReadonlyArray<boolean>;
    providerConfigured: boolean;
  }>
): Effect.Effect<ReadonlyArray<CapabilityProbe>> =>
  Effect.gen(function* () {
    const d1 = yield* Effect.exit(
      Effect.tryPromise(() => input.d1.prepare("SELECT 1 AS usable").first()).pipe(
        Effect.timeout("2 seconds"),
        Effect.flatMap(Schema.decodeUnknownEffect(Available))
      )
    );
    const coordination = yield* Effect.exit(
      Effect.tryPromise((signal) =>
        input.coordinator.getByName(coordinatorProbeName).fetch(new Request(probeUrl, { signal }))
      ).pipe(Effect.timeout("2 seconds"))
    );
    const status = (ready: boolean): CapabilityProbe["state"] =>
      ready ? "healthy" : "unavailable";
    return [
      { component: "capability", operation: "d1", state: status(Exit.isSuccess(d1)) },
      {
        component: "capability",
        operation: "requiredBindings",
        state: status(input.requiredBindings.every(Boolean)),
      },
      {
        component: "capability",
        operation: "coordination",
        state: status(
          Exit.isSuccess(coordination) && coordination.value.status === probeSuccessStatus
        ),
      },
      {
        component: "capability",
        operation: "providerConfig",
        state: status(input.providerConfigured),
      },
    ];
  });

const minuteMs = 60_000;
