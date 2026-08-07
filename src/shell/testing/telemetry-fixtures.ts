import type { SpanDescriptor } from "~/shell/observability/protocol";

const hostedTurnIdentity = {
  component: "agent",
  operation: "agent.hostedTurn",
  trigger: "api",
  spanOperation: "agent.turn",
} as const;

/**
 * One work kind paired with the metadata shape that kind admits, distributed over the descriptor
 * union so an unrelated pairing — a queue attempt carrying HTTP metadata — does not typecheck.
 */
type WorkOf<Descriptor> = Descriptor extends SpanDescriptor
  ? Pick<Descriptor, "metadata" | "workKind">
  : never;

/** The varying half of a span descriptor: what kind of work it is, and that kind's own metadata. */
export type SpanWork = WorkOf<SpanDescriptor>;

/** Builds the approved hosted-turn descriptor used by telemetry seam tests. */
export const makeSpanDescriptor = (): SpanDescriptor => ({
  ...hostedTurnIdentity,
  workKind: "hosted_turn",
  metadata: { _tag: "None" },
});

/** Builds a descriptor for one work kind, keeping the hosted-turn identity every seam test shares. */
export const makeWorkSpanDescriptor = (work: SpanWork): SpanDescriptor => ({
  ...hostedTurnIdentity,
  ...work,
});
