import { type Effect, Schema } from "effect";
import type { PersistedQueue } from "effect/unstable/persistence";
import type { TelemetryCode } from "~/shell/observability/contract";

/** The only retry causes that the application boundary permits the queue store to retain. */
export const PersistedQueueHandlerFailure = Schema.TaggedStruct("PersistedQueueHandlerFailure", {
  reason: Schema.Literals(["transient", "unexpected-defect"]),
});
export type PersistedQueueHandlerFailure = typeof PersistedQueueHandlerFailure.Type;

/** Bounded permanent rejection classes that an owning consumer may record as terminal state. */
export const PersistedQueueTerminalReason = Schema.Literals([
  "payload-rejected",
  "identity-rejected",
  "domain-rejected",
]);
export type PersistedQueueTerminalReason = typeof PersistedQueueTerminalReason.Type;

/** A consumer's exhaustive decision for one expected handler failure. */
export const PersistedQueueFailureDisposition = Schema.Union([
  Schema.TaggedStruct("Retry", { reason: Schema.Literal("transient") }),
  Schema.TaggedStruct("Terminal", { reason: PersistedQueueTerminalReason }),
]);
export type PersistedQueueFailureDisposition = typeof PersistedQueueFailureDisposition.Type;

/** Stable bounded observability coordinates for one application-owned queue consumer. */
export type PersistedQueueHandlerDescriptor = Readonly<{
  component: TelemetryCode<"component">;
  operation: TelemetryCode<"operation">;
}>;

/** Stable protocol identity shared by queue execution and compatibility evidence. */
export type ApplicationPersistedQueueDefinition<
  PayloadSchema extends Schema.Constraint,
  Name extends string,
> = Readonly<{
  name: Name;
  schema: PayloadSchema;
}>;

/** Identity and attempt count supplied to one sanitized handler execution. */
export type PersistedQueueMetadata = Readonly<{
  id: string;
  attempts: number;
}>;

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
    metadata: PersistedQueueMetadata,
    reason: PersistedQueueTerminalReason
  ) => Effect.Effect<void, TerminalError, TerminalRequirements>;
}>;

/** Type-only name for the queue Effect requirement; it exports no raw service identifier. */
export type ApplicationPersistedQueueRequirement = PersistedQueue.PersistedQueueFactory;

/** Captured wiring capability that satisfies queue requirements without exposing construction. */
export type ApplicationPersistedQueueProvider = Readonly<{
  provide: <A, E, R>(
    effect: Effect.Effect<A, E, R>
  ) => Effect.Effect<A, E, Exclude<R, PersistedQueue.PersistedQueueFactory>>;
}>;

/** Native offer options retained so custom identity has exactly the store's semantics. */
export type PersistedQueueOfferOptions = Parameters<
  PersistedQueue.PersistedQueue<never>["offer"]
>[1];

/** Native delivery ceiling options accepted only by the sanitized handling operation. */
export type PersistedQueueHandleOptions = Parameters<
  PersistedQueue.PersistedQueue<never>["take"]
>[1];

/**
 * A declared durable protocol. Producers can only offer schema-encoded payloads and consumers can
 * only handle the next item through the exhaustive disposition boundary; raw construction, take,
 * and settlement authority are not part of this interface.
 */
export type ApplicationPersistedQueue<
  PayloadSchema extends Schema.Constraint,
  Name extends string,
> = Readonly<{
  definition: ApplicationPersistedQueueDefinition<PayloadSchema, Name>;
  offer: (
    value: PayloadSchema["Type"],
    options?: PersistedQueueOfferOptions
  ) => Effect.Effect<
    string,
    PersistedQueue.PersistedQueueError | Schema.SchemaError,
    | PersistedQueue.PersistedQueueFactory
    | PayloadSchema["EncodingServices"]
    | PayloadSchema["DecodingServices"]
  >;
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
    options?: PersistedQueueHandleOptions
  ) => Effect.Effect<
    void,
    PersistedQueueHandlerFailure | PersistedQueue.PersistedQueueError | Schema.SchemaError,
    | PersistedQueue.PersistedQueueFactory
    | PayloadSchema["EncodingServices"]
    | PayloadSchema["DecodingServices"]
    | XR
    | TerminalRequirements
  >;
}>;
