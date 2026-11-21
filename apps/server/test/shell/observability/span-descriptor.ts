import { NoSpanMetadata, type SpanDescriptor } from "~/shell/observability/contract";

export const makeSpanDescriptor = (): SpanDescriptor => ({
  component: "agent",
  operation: "agent.hostedTurn",
  trigger: "api",
  spanOperation: "agent.turn",
  workKind: "hosted_turn",
  metadata: NoSpanMetadata.make({}),
});
