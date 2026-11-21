import { Schema } from "effect";

export const WompiEnvironment = Schema.Literals(["sandbox", "production"]).annotate({
  identifier: "WompiEnvironment",
});

export type WompiEnvironment = typeof WompiEnvironment.Type;
