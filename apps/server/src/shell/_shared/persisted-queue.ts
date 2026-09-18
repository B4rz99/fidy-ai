import * as Arr from "effect/Array";
import { Cause, Effect, Option, Schema } from "effect";
import { PersistedQueue } from "effect/unstable/persistence";
import {
  DisabledTelemetry,
  Telemetry,
  type TelemetryService,
} from "~/shell/observability/operations";
import {
  DurableQueueName,
  type DurableQueueName as DurableQueueNameType,
} from "~/shell/durable-queue-policy";

import {
  type PersistedQueueFailureDisposition,
  type PersistedQueueHandlerDescriptor,
  PersistedQueueHandlerFailure,
  type PersistedQueueTerminalReason,
} from "./persisted-queue-handler";

/**
 * Policy supplied by an owning queue consumer. Classification must be total for the handler's typed
 * failures. Recording a terminal reason must idempotently establish the owning domain disposition
 * because the queue may replay it; if that write fails, the item remains retryable rather than
 * completing without its evidence.
 *
 * The consumer remains responsible for its bounded Work span, latency, retry, and continuation
 * metrics because it owns the operation-specific safe metadata. This boundary observes only
 * unexpected defects so it neither duplicates consumer telemetry nor raises expected dispositions.
 */
type PersistedQueueHandlerOptions<HandlerFailure, TerminalError, TerminalRequirements> = Readonly<{
  descriptor: PersistedQueueHandlerDescriptor;
  classify: (failure: HandlerFailure) => PersistedQueueFailureDisposition;
  recordTerminal: (
    reason: PersistedQueueTerminalReason
  ) => Effect.Effect<void, TerminalError, TerminalRequirements>;
}>;

const makeHandlerFailure = (
  reason: PersistedQueueHandlerFailure["reason"]
): PersistedQueueHandlerFailure => ({
  _tag: "PersistedQueueHandlerFailure",
  reason,
});

const failRedacted = <Failure extends unknown>(
  cause: Cause.Cause<Failure>,
  reason: PersistedQueueHandlerFailure["reason"]
): Effect.Effect<never, PersistedQueueHandlerFailure> =>
  Effect.failCause(Cause.map(cause, () => makeHandlerFailure(reason)));

const queueTelemetry = Effect.serviceOption(Telemetry).pipe(
  Effect.map(Option.getOrElse(() => DisabledTelemetry))
);

const observeDefect = (
  telemetry: TelemetryService,
  descriptor: PersistedQueueHandlerDescriptor,
  cause: Cause.Cause<unknown>
): Effect.Effect<void> =>
  telemetry
    .captureFailure({
      _tag: "Defect",
      component: descriptor.component,
      operation: descriptor.operation,
      error: "unexpected_defect",
      cause,
    })
    .pipe(
      Effect.andThen(
        Effect.logError(
          `Persisted queue handler defect [${descriptor.component}:${descriptor.operation}:unexpected_defect]`
        )
      )
    );

const captureDefect = (
  telemetry: TelemetryService,
  descriptor: PersistedQueueHandlerDescriptor,
  cause: Cause.Cause<unknown>
): Effect.Effect<never, PersistedQueueHandlerFailure> =>
  observeDefect(telemetry, descriptor, cause).pipe(
    Effect.andThen(Effect.fail(makeHandlerFailure("unexpected-defect")))
  );

const expectedFailures = <Failure extends unknown>(
  cause: Cause.Cause<Failure>
): ReadonlyArray<Failure> =>
  Arr.filter(cause.reasons, Cause.isFailReason).map((reason) => reason.error);

const interruptionOnly = <Failure extends unknown>(
  cause: Cause.Cause<Failure>
): Cause.Cause<never> => Cause.fromReasons(Arr.filter(cause.reasons, Cause.isInterruptReason));

const recordTerminal = <HandlerFailure, TerminalError, TerminalRequirements>(
  reason: PersistedQueueTerminalReason,
  options: PersistedQueueHandlerOptions<HandlerFailure, TerminalError, TerminalRequirements>,
  telemetry: TelemetryService
): Effect.Effect<void, PersistedQueueHandlerFailure, TerminalRequirements> =>
  Effect.suspend(() => options.recordTerminal(reason)).pipe(
    Effect.catchCause((cause) =>
      Cause.hasDies(cause)
        ? captureDefect(telemetry, options.descriptor, cause)
        : failRedacted(cause, "transient")
    ),
    Effect.asVoid
  );

const classifyFailures = <HandlerFailure, TerminalError, TerminalRequirements>(
  failures: ReadonlyArray<HandlerFailure>,
  options: PersistedQueueHandlerOptions<HandlerFailure, TerminalError, TerminalRequirements>,
  telemetry: TelemetryService
): Effect.Effect<void, PersistedQueueHandlerFailure, TerminalRequirements> =>
  Effect.sync(() => failures.map(options.classify)).pipe(
    Effect.catchCause((cause) => captureDefect(telemetry, options.descriptor, cause)),
    Effect.flatMap((dispositions) => {
      const terminalReasons = new Set<PersistedQueueTerminalReason>();
      for (const disposition of dispositions) {
        if (disposition._tag === "Retry") return Effect.fail(makeHandlerFailure("transient"));
        terminalReasons.add(disposition.reason);
      }
      return Effect.forEach(
        Array.from(terminalReasons),
        (reason) => recordTerminal(reason, options, telemetry),
        { discard: true }
      );
    })
  );

const redactInterruptedCause = <HandlerFailure, TerminalError, TerminalRequirements>(
  cause: Cause.Cause<HandlerFailure>,
  options: PersistedQueueHandlerOptions<HandlerFailure, TerminalError, TerminalRequirements>,
  telemetry: TelemetryService
): Effect.Effect<void, PersistedQueueHandlerFailure, TerminalRequirements> => {
  const interrupted = Effect.failCause(interruptionOnly(cause));
  if (Cause.hasDies(cause)) {
    return observeDefect(telemetry, options.descriptor, cause).pipe(Effect.andThen(interrupted));
  }
  return interrupted;
};

const redactExpectedCause = <HandlerFailure, TerminalError, TerminalRequirements>(
  cause: Cause.Cause<HandlerFailure>,
  options: PersistedQueueHandlerOptions<HandlerFailure, TerminalError, TerminalRequirements>,
  telemetry: TelemetryService
): Effect.Effect<void, PersistedQueueHandlerFailure, TerminalRequirements> => {
  const failures = expectedFailures(cause);
  if (!Arr.isReadonlyArrayNonEmpty(failures)) {
    return captureDefect(telemetry, options.descriptor, cause);
  }
  return classifyFailures(failures, options, telemetry);
};

const redactUninterruptedCause = <HandlerFailure, TerminalError, TerminalRequirements>(
  cause: Cause.Cause<HandlerFailure>,
  options: PersistedQueueHandlerOptions<HandlerFailure, TerminalError, TerminalRequirements>,
  telemetry: TelemetryService
): Effect.Effect<void, PersistedQueueHandlerFailure, TerminalRequirements> => {
  if (Cause.hasDies(cause)) return captureDefect(telemetry, options.descriptor, cause);
  return redactExpectedCause(cause, options, telemetry);
};

const redactHandlerCause = <HandlerFailure, TerminalError, TerminalRequirements>(
  cause: Cause.Cause<HandlerFailure>,
  options: PersistedQueueHandlerOptions<HandlerFailure, TerminalError, TerminalRequirements>,
  telemetry: TelemetryService
): Effect.Effect<void, PersistedQueueHandlerFailure, TerminalRequirements> => {
  if (Cause.hasInterrupts(cause)) return redactInterruptedCause(cause, options, telemetry);
  return redactUninterruptedCause(cause, options, telemetry);
};

/**
 * Converts one opt-in PersistedQueue handler execution to a closed durable failure vocabulary.
 * Expected transient failures retry, permanent rejections complete only after their bounded outcome
 * is recorded, unexpected defects are captured once, and interruption-only causes are unchanged.
 */
const runPersistedQueueHandler =
  <HandlerFailure, TerminalError, TerminalRequirements>(
    options: PersistedQueueHandlerOptions<HandlerFailure, TerminalError, TerminalRequirements>
  ) =>
  <A, R>(
    work: Effect.Effect<A, HandlerFailure, R>
  ): Effect.Effect<void, PersistedQueueHandlerFailure, R | TerminalRequirements> =>
    Effect.gen(function* () {
      const telemetry = yield* queueTelemetry;
      return yield* work.pipe(
        Effect.asVoid,
        Effect.catchCause((cause) => redactHandlerCause(cause, options, telemetry))
      );
    });

const canonicalHandlerFailure = (
  cause: Cause.Cause<PersistedQueueHandlerFailure>
): Option.Option<PersistedQueueHandlerFailure> => {
  const failures = expectedFailures(cause);
  if (
    !Arr.isReadonlyArrayNonEmpty(failures) ||
    Cause.hasDies(cause) ||
    Cause.hasInterrupts(cause) ||
    !failures.every(Schema.is(PersistedQueueHandlerFailure))
  ) {
    return Option.none<PersistedQueueHandlerFailure>();
  }
  return Option.some(
    PersistedQueueHandlerFailure.make({
      reason: failures.some(({ reason }) => reason === "unexpected-defect")
        ? "unexpected-defect"
        : "transient",
    })
  );
};

/**
 * Enforces the final queue-consumer boundary after an owning classifier has handled expected
 * outcomes. Already-redacted failures and pure interruption pass through; any bypassing defect is
 * observed once and replaced before Effect's queue store can render it durably.
 */
const enforcePersistedQueueHandler =
  (descriptor: PersistedQueueHandlerDescriptor) =>
  <A, R>(
    work: Effect.Effect<A, PersistedQueueHandlerFailure, R>
  ): Effect.Effect<A, PersistedQueueHandlerFailure, R> =>
    Effect.flatMap(queueTelemetry, (telemetry) =>
      work.pipe(
        Effect.catchCause((cause) => {
          if (Cause.hasInterrupts(cause)) {
            const interrupted = Effect.failCause(interruptionOnly(cause));
            return Cause.hasDies(cause)
              ? observeDefect(telemetry, descriptor, cause).pipe(Effect.andThen(interrupted))
              : interrupted;
          }
          return Option.match(canonicalHandlerFailure(cause), {
            onNone: () => captureDefect(telemetry, descriptor, cause),
            onSome: Effect.fail,
          });
        })
      )
    );

type QueueMetadata = Readonly<{
  id: string;
  attempts: number;
}>;

type QueueTakeOptions<A, R> = Parameters<PersistedQueue.PersistedQueue<A, R>["take"]>[1];

/** Classification and idempotent terminal settlement required for every consumed payload. */
export type ApplicationPersistedQueueHandlerPolicy<
  A,
  HandlerFailure,
  TerminalError,
  TerminalRequirements,
> = Readonly<{
  classify: (failure: HandlerFailure) => PersistedQueueFailureDisposition;
  recordTerminal: (
    value: A,
    metadata: QueueMetadata,
    reason: PersistedQueueTerminalReason
  ) => Effect.Effect<void, TerminalError, TerminalRequirements>;
}>;

const applyQueueHandlerPolicy = <A, XA, HandlerFailure, XR, TerminalError, TerminalRequirements>(
  input: Readonly<{
    value: A;
    metadata: QueueMetadata;
    handler: (value: A, metadata: QueueMetadata) => Effect.Effect<XA, HandlerFailure, XR>;
    policy: ApplicationPersistedQueueHandlerPolicy<
      A,
      HandlerFailure,
      TerminalError,
      TerminalRequirements
    >;
    descriptor: PersistedQueueHandlerDescriptor;
  }>
): Effect.Effect<void, PersistedQueueHandlerFailure, XR | TerminalRequirements> =>
  Effect.suspend(() => input.handler(input.value, input.metadata)).pipe(
    runPersistedQueueHandler({
      descriptor: input.descriptor,
      classify: input.policy.classify,
      recordTerminal: (reason) => input.policy.recordTerminal(input.value, input.metadata, reason),
    }),
    enforcePersistedQueueHandler(input.descriptor)
  );

/**
 * A durable application handoff with native offer semantics and one consumer operation. Consumption
 * requires exhaustive failure classification, idempotent terminal settlement, redacted persistence,
 * mandatory metadata-only defect logging plus configured telemetry capture, and interruption-safe
 * lease release.
 */
/** Type-only name for the queue Effect requirement; it exports no raw service identifier. */
export type ApplicationPersistedQueueRequirement = PersistedQueue.PersistedQueueFactory;

/** Captured wiring capability that can provide queue persistence without exposing raw construction. */
export type ApplicationPersistedQueueProvider = Readonly<{
  provide: <A, E, R>(
    effect: Effect.Effect<A, E, R>
  ) => Effect.Effect<A, E, Exclude<R, PersistedQueue.PersistedQueueFactory>>;
}>;

/** Captures only the capability to satisfy queue requirements; the raw factory never escapes. */
export const applicationPersistedQueueProvider: Effect.Effect<
  ApplicationPersistedQueueProvider,
  never,
  PersistedQueue.PersistedQueueFactory
> = PersistedQueue.PersistedQueueFactory.pipe(
  Effect.map((factory) => ({
    provide: (effect) =>
      Effect.provideService(effect, PersistedQueue.PersistedQueueFactory, factory),
  }))
);

export type ApplicationPersistedQueue<PayloadSchema extends Schema.Constraint> = Readonly<{
  offer: PersistedQueue.PersistedQueue<
    PayloadSchema["Type"],
    PayloadSchema["EncodingServices"] | PayloadSchema["DecodingServices"]
  >["offer"];
  take: <XA, HandlerFailure, XR, TerminalError, TerminalRequirements>(
    handler: (
      value: PayloadSchema["Type"],
      metadata: QueueMetadata
    ) => Effect.Effect<XA, HandlerFailure, XR>,
    policy: ApplicationPersistedQueueHandlerPolicy<
      PayloadSchema["Type"],
      HandlerFailure,
      TerminalError,
      TerminalRequirements
    >,
    options?: QueueTakeOptions<
      PayloadSchema["Type"],
      PayloadSchema["EncodingServices"] | PayloadSchema["DecodingServices"]
    >
  ) => Effect.Effect<
    void,
    PersistedQueueHandlerFailure | PersistedQueue.PersistedQueueError | Schema.SchemaError,
    | PayloadSchema["EncodingServices"]
    | PayloadSchema["DecodingServices"]
    | XR
    | TerminalRequirements
  >;
}>;

/** Stable protocol identity shared by runtime construction and compatibility evidence. */
export type ApplicationPersistedQueueDefinition<
  PayloadSchema extends Schema.Constraint,
  Name extends string,
> = Readonly<{
  name: Name;
  schema: PayloadSchema;
}>;

/** Queue construction carrying its exact durable protocol definition without widening runtime access. */
export type ApplicationPersistedQueueConstruction<
  PayloadSchema extends Schema.Constraint,
  Name extends string,
> = Effect.Effect<
  ApplicationPersistedQueue<PayloadSchema>,
  never,
  PersistedQueue.PersistedQueueFactory
> &
  Readonly<{
    definition: ApplicationPersistedQueueDefinition<PayloadSchema, Name>;
  }>;

const applicationQueueNames = new Set<DurableQueueNameType>();

/** Returns queue identities registered by application queue construction in this process. */
export const applicationPersistedQueueNames = (): ReadonlyArray<DurableQueueNameType> =>
  Array.from(applicationQueueNames).sort();

/**
 * Defines one named durable handoff. Offers preserve custom identity and schema encoding; takes
 * require the owning disposition policy and expose only the closed redacted failure vocabulary.
 */
export const makePersistedQueue = <
  PayloadSchema extends Schema.Constraint,
  const Name extends string,
>(options: {
  readonly name: Name;
  readonly schema: PayloadSchema;
  readonly descriptor: PersistedQueueHandlerDescriptor;
}): ApplicationPersistedQueueConstruction<PayloadSchema, Name> => {
  applicationQueueNames.add(DurableQueueName.make(options.name));
  const construction = PersistedQueue.make({ name: options.name, schema: options.schema }).pipe(
    Effect.map((queue): ApplicationPersistedQueue<PayloadSchema> => ({
      offer: queue.offer,
      take: (handler, policy, takeOptions) =>
        queue.take(
          (value, metadata) =>
            applyQueueHandlerPolicy({
              value,
              metadata,
              handler,
              policy,
              descriptor: options.descriptor,
            }),
          takeOptions
        ),
    }))
  );
  return Object.assign(construction, {
    definition: Object.freeze({
      name: options.name,
      schema: options.schema,
    }),
  });
};
