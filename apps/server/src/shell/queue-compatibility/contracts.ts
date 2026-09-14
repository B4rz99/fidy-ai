import type { Schema } from "effect";
import type { ApplicationPersistedQueueDefinition } from "~/shell/_shared/persisted-queue";
import {
  DurableQueueName,
  type DurableQueueName as DurableQueueNameType,
} from "~/shell/durable-queue-policy";

/** SQL column bound enforced by Effect's PersistedQueue migration for queue names. */
export const maximumQueueNameLength = 100;

/** SQL column bound enforced by Effect's PersistedQueue migration for custom ids. */
export const maximumQueueIdLength = 36;

/**
 * One production queue's compatibility contract. The schema is the decoder the owning slice builds
 * its queue with; the fixture (`<name>.json`) is the oldest supported encoding; the identity fields
 * are the domain ownership and operation identity that must survive a rolling deployment without
 * changing deduplication or stranding work.
 */
export type QueueCompatibilityContract<
  SchemaType extends Schema.Codec<unknown, unknown, never, never> = Schema.Codec<
    unknown,
    unknown,
    never,
    never
  >,
> = {
  readonly name: DurableQueueNameType;
  readonly schema: SchemaType;
  readonly identityFields: ReadonlyArray<string>;
  readonly userFields: ReadonlyArray<string>;
};

/**
 * Defines compatibility evidence from the exact production queue definition. Name and schema cannot
 * be restated independently, so each discovered contract remains tied to that constructor.
 */
export const defineQueueCompatibilityContract = <
  SchemaValue extends Schema.Codec<unknown, unknown, never, never>,
  const Name extends string,
>(contract: {
  readonly definition: ApplicationPersistedQueueDefinition<SchemaValue, Name>;
  readonly identityFields: ReadonlyArray<string>;
  readonly userFields: ReadonlyArray<string>;
}): QueueCompatibilityContract<SchemaValue> => ({
  name: DurableQueueName.make(contract.definition.name),
  schema: contract.definition.schema,
  identityFields: contract.identityFields,
  userFields: contract.userFields,
});
