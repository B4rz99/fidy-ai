import { Schema } from "effect";
import { ErasureOperatorReceipt } from "../../../src/core/erasure/contract";

const Stored = Schema.Struct({
  state: ErasureOperatorReceipt.fields.state,
  connectionBlocked: Schema.Literals([0, 1]),
  lastErasedAtMs: Schema.OptionFromNullOr(Schema.Int),
});

export const receiptNext = (
  stored: Pick<typeof Stored.Type, "state" | "connectionBlocked">
): typeof ErasureOperatorReceipt.Type.next => {
  if (stored.connectionBlocked === 1) return "connection-suppression";

  if (stored.state === "Draining") return "admitted-work";

  if (stored.state === "Complete") return "none";

  if (stored.state !== "ExternalPending") return "continue";

  return "provider-evidence";
};
