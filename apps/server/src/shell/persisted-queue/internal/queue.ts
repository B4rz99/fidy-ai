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
} from "~/shell/persisted-queue/contract";
import {
  DurableQueueName,
  type DurableQueueName as DurableQueueNameType,
} from "~/shell/durable-queue-policy";
import { applyQueueHandlerPolicy } from "./handler";

const applicationQueueNames = new Set<DurableQueueNameType>();

/** Reads queue identities registered by declarations in this process. */
export const readApplicationQueueNames = (): ReadonlyArray<DurableQueueNameType> =>
  Array.from(applicationQueueNames).sort();

/** Captures queue wiring authority without allowing the raw factory to escape. */
export const capturedQueueProvider: Effect.Effect<
  ApplicationPersistedQueueProvider,
  never,
  PersistedQueue.PersistedQueueFactory
> = PersistedQueue.PersistedQueueFactory.pipe(
  Effect.map((factory) => ({
    provide: (effect) =>
      Effect.provideService(effect, PersistedQueue.PersistedQueueFactory, factory),
  }))
);

/** Constructs the private Effect queue behind one application declaration. */
export const declareApplicationQueue = <
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
