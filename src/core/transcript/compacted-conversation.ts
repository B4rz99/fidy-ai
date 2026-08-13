import { Schema, Struct } from "effect";
import { CompactedConversation } from "./model";

const CompactedConversationText = CompactedConversation.mapFields(Struct.pick(["text"]));

/** Strict hosted output derived from the canonical replacement text before token validation. */
export const CompactedConversationOutput = Schema.Struct({
  compactedConversation: CompactedConversationText.fields.text,
});
export type CompactedConversationOutput = typeof CompactedConversationOutput.Type;

export { CompactedConversation };
