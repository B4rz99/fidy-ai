import { Option } from "effect";

/** Read-only decision input compatible with Effect Option values without exposing instance methods. */
export type ReadonlyOption<Value> =
  | Readonly<{ readonly _tag: Option.None<Value>["_tag"] }>
  | Readonly<{ readonly _tag: Option.Some<Value>["_tag"]; readonly value: Value }>;

type ToOption = <Value>(option: ReadonlyOption<Value>) => Option.Option<Value>;

/** Rebuilds the Effect Option a read-only input denotes, so the Option combinators apply to it. */
export const toOption: ToOption = (option) =>
  option._tag === "Some" ? Option.some(option.value) : Option.none();
