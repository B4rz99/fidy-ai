import { Context, Effect } from "effect";
import type { AgentReply } from "./message";

/**
 * Runner-local acknowledgement for immediate clients. The CLI consumes the returned RPC reply;
 * this acknowledgement does not claim that its terminal displayed it. External delivery tests
 * substitute this adapter when constructing the runner, never send a closure through Cluster.
 */
export const ImmediateDelivery = Context.Reference<{
  readonly deliver: (reply: AgentReply) => Effect.Effect<void, "delivery_failed">;
}>("@fidy/server/shell/agent/ImmediateDelivery", {
  defaultValue: () => ({ deliver: (): Effect.Effect<void> => Effect.void }),
});
