import { Schema } from "effect";

/** The User's current capability tier derived at the decision instant. */
export const AccessTier = Schema.Literals(["free", "pro"]).annotate({
  identifier: "AccessTier",
});
export type AccessTier = typeof AccessTier.Type;
