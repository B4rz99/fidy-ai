import type { SpanDescriptor } from "./contract";

export const makeSpanDescriptor = (): SpanDescriptor => ({
  component: "agent",
  operation: "agent.hostedTurn",
  trigger: "api",
  spanOperation: "agent.turn",
  workKind: "hosted_turn",
  metadata: { _tag: "None" },
});
