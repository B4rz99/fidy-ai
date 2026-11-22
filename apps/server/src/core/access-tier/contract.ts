import { Schema } from "effect";

export const AccessTier = Schema.Literals(["free", "pro"]).annotate({
  identifier: "AccessTier",
});

export type AccessTier = typeof AccessTier.Type;
