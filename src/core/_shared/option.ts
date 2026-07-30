import type { Option } from "effect";

/** Read-only decision input compatible with Effect Option values without exposing instance methods. */
export type ReadonlyOption<Value> =
  | Readonly<{ readonly _tag: Option.None<Value>["_tag"] }>
  | Readonly<{ readonly _tag: Option.Some<Value>["_tag"]; readonly value: Value }>;
