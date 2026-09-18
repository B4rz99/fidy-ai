import { Effect, type Schema } from "effect";
import {
  type ApplicationPersistedQueue,
  type ApplicationPersistedQueueProvider,
  type ApplicationPersistedQueueRequirement,
  type PersistedQueueHandlerDescriptor,
} from "./contract";
import type { DurableQueueName } from "~/shell/durable-queue-policy";
import {
  applicationPersistedQueueProvider as applicationPersistedQueueProviderInternal,
  declareApplicationPersistedQueue,
  readApplicationPersistedQueueNames,
} from "~/shell/persisted-queue/internal/queue";

/** Returns queue identities registered by application queue declarations in this process. */
export const applicationPersistedQueueNames = (): ReadonlyArray<DurableQueueName> =>
  readApplicationPersistedQueueNames();

/** Captures only the capability to satisfy queue requirements; the raw factory never escapes. */
export const applicationPersistedQueueProvider: Effect.Effect<
  ApplicationPersistedQueueProvider,
  never,
  ApplicationPersistedQueueRequirement
> = Effect.suspend(() => applicationPersistedQueueProviderInternal);

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
}): ApplicationPersistedQueue<PayloadSchema, Name> => declareApplicationPersistedQueue(options);
