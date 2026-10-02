import { Schema } from "effect";

/** Credential namespace that must agree with provider transport and retained billing evidence. */
export const WompiEnvironment = Schema.Literals(["sandbox", "production"]).annotate({
  identifier: "WompiEnvironment",
});
export type WompiEnvironment = typeof WompiEnvironment.Type;
