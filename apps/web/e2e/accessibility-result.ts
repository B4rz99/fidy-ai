import type { AxeResults } from "axe-core";
import { Schema } from "effect";

const selector = Schema.mutable(
  Schema.Array(
    Schema.Union([
      Schema.String,
      Schema.mutable(
        Schema.TupleWithRest(Schema.Tuple([Schema.String, Schema.String]), [Schema.String])
      ),
    ])
  )
);
const relatedNode = Schema.Struct({ html: Schema.String, target: selector });
const check = Schema.Struct({
  id: Schema.String,
  impact: Schema.String,
  message: Schema.String,
  data: Schema.Unknown,
  relatedNodes: Schema.optionalKey(Schema.mutable(Schema.Array(relatedNode))),
});
const impact = Schema.optionalKey(
  Schema.NullOr(Schema.Literals(["minor", "moderate", "serious", "critical"]))
);
const node = Schema.Struct({
  html: Schema.String,
  target: selector,
  impact,
  any: Schema.mutable(Schema.Array(check)),
  all: Schema.mutable(Schema.Array(check)),
  none: Schema.mutable(Schema.Array(check)),
});
const rules = Schema.mutable(
  Schema.Array(
    Schema.Struct({
      id: Schema.String,
      description: Schema.String,
      help: Schema.String,
      helpUrl: Schema.String,
      impact,
      tags: Schema.mutable(Schema.Array(Schema.String)),
      nodes: Schema.mutable(Schema.Array(node)),
    })
  )
);
const isAccessibilityResult = Schema.is(
  Schema.Struct({
    testEngine: Schema.Struct({ name: Schema.String, version: Schema.String }),
    testRunner: Schema.Struct({ name: Schema.String }),
    testEnvironment: Schema.Struct({
      userAgent: Schema.String,
      windowWidth: Schema.Finite,
      windowHeight: Schema.Finite,
    }),
    url: Schema.String,
    timestamp: Schema.String,
    toolOptions: Schema.Struct({ reporter: Schema.optionalKey(Schema.String) }),
    violations: rules,
    passes: rules,
    incomplete: rules,
    inapplicable: rules,
  })
);

/** Validate the protocol boundary without projecting away any engine result or metadata. */
export const readAccessibilityResult = (value: unknown): AxeResults => {
  if (!isAccessibilityResult(value)) throw new Error("Invalid accessibility evaluation result");
  return value;
};
