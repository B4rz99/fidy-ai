import { Schema } from "effect";
import type { TelemetryCode } from "~/shell/observability/contract";

/** The only retry causes that this boundary permits PersistedQueue to render durably. */
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

/** Stable metadata coordinates for one application-owned queue consumer. */
export type PersistedQueueHandlerDescriptor = Readonly<{
  component: TelemetryCode<"component">;
  operation: TelemetryCode<"operation">;
}>;
