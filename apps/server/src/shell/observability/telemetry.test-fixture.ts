import type { SpanDescriptor } from "./contract";

/** Builds the approved hosted-turn descriptor used by owner-local telemetry seam tests. */
export const makeSpanDescriptor = (): SpanDescriptor => ({
  component: "agent",
  operation: "agent.hostedTurn",
  trigger: "api",
  spanOperation: "agent.turn",
  workKind: "hosted_turn",
  metadata: { _tag: "None" },
});
