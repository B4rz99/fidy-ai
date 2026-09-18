import { Effect, type Schema } from "effect";
import { PersistedQueue } from "effect/unstable/persistence";
import {
  type ApplicationPersistedQueue,
  type ApplicationPersistedQueueHandlerPolicy,
  type ApplicationPersistedQueueProvider,
  type PersistedQueueHandleOptions,
  type PersistedQueueHandlerDescriptor,
  type PersistedQueueMetadata,
  type PersistedQueueOfferOptions,
} from "./contract";
import {
  DurableQueueName,
  type DurableQueueName as DurableQueueNameType,
} from "~/shell/durable-queue-policy";
import { applyQueueHandlerPolicy } from "~/shell/persisted-queue/internal/handler";

const applicationQueueNames = new Set<DurableQueueNameType>();

/** Returns queue identities registered by application queue declarations in this process. */
export const applicationPersistedQueueNames = (): ReadonlyArray<DurableQueueNameType> =>
  Array.from(applicationQueueNames).sort();

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

/**
 * Declares one named durable handoff. Offers preserve custom identity, schema encoding, and the
 * caller's active SQL transaction. Handling is available only through exhaustive classification,
 * idempotent terminal disposition, redacted failures, defect observation, and interruption-safe
 * lease release.
 */
export const declarePersistedQueue = <
  PayloadSchema extends Schema.Constraint,
  const Name extends string,
>(options: {
  readonly name: Name;
  readonly schema: PayloadSchema;
  readonly descriptor: PersistedQueueHandlerDescriptor;
}): ApplicationPersistedQueue<PayloadSchema, Name> => {
  applicationQueueNames.add(DurableQueueName.make(options.name));
  const definition = Object.freeze({ name: options.name, schema: options.schema });
  const makeQueue = PersistedQueue.make(definition);

  return {
    definition,
    offer: (value: PayloadSchema["Type"], offerOptions?: PersistedQueueOfferOptions) =>
      makeQueue.pipe(Effect.flatMap((queue) => queue.offer(value, offerOptions))),
    handleNext: <XA, HandlerFailure, XR, TerminalError, TerminalRequirements>(
      handler: (
        value: PayloadSchema["Type"],
        metadata: PersistedQueueMetadata
      ) => Effect.Effect<XA, HandlerFailure, XR>,
      policy: ApplicationPersistedQueueHandlerPolicy<
        PayloadSchema["Type"],
        HandlerFailure,
        TerminalError,
        TerminalRequirements
      >,
      handleOptions?: PersistedQueueHandleOptions
    ) =>
      makeQueue.pipe(
        Effect.flatMap((queue) =>
          queue.take(
            (value, metadata) =>
              applyQueueHandlerPolicy({
                value,
                metadata,
                handler,
                policy,
                descriptor: options.descriptor,
              }),
            handleOptions
          )
        )
      ),
  };
};
