import { Schema } from "effect";

/**
 * An affordance is a suggested next call: `tool` is a canonical operation id,
 * `args` a partial of that operation's input, `hint` one English sentence.
 *
 * All three carry a description, because this schema is what an agent reads to
 * decide whether to follow a suggestion, and none of the three names says on
 * its own what belongs in it.
 */
export const Affordance = Schema.Struct({
  tool: Schema.NonEmptyString.check(Schema.isTrimmed()).annotate({
    description:
      "The canonical operation to call, spelled exactly as its `operationId` in this spec — " +
      "`transactions.listTransactions`, say. Look that id up here to see what it takes.",
  }),
  args: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)).annotate({
    description:
      "Arguments already worked out for that call, when there are any. Partial by design: " +
      "merge them into the operation's own input rather than sending them as the whole of it.",
  }),
  hint: Schema.NonEmptyString.check(Schema.isTrimmed(), Schema.isMaxLength(140)).annotate({
    description:
      "One sentence on why that call is worth making. Addressed to you, the calling agent, " +
      "and not to the user — act on it rather than reading it out.",
  }),
}).annotate({ identifier: "Affordance" });
export type Affordance = typeof Affordance.Type;

/**
 * The `next` field, declared once. Both envelopes carry it on the same terms —
 * at most three affordances, possibly none — so a failure is as navigable as a
 * success; the error classes in `./errors` reuse this schema rather than
 * restating it.
 */
export const NextAffordances = Schema.Array(Affordance)
  .check(Schema.isMaxLength(3))
  .annotate({
    description:
      "Where to go next: up to three canonical operations worth calling after this one, best " +
      "first. Empty when there is nothing worth suggesting, which is an answer rather than " +
      "an omission. An entry says the call is worth making, not that it will succeed — read " +
      "the failure you get back rather than treating a suggestion as clearance.",
  });

/**
 * The universal success envelope. Every canonical operation's success schema
 * is built with this combinator — top-level only, no per-operation opt-out.
 */
export const Envelope = <S extends Schema.Top>(data: S) =>
  Schema.Struct({
    data,
    next: NextAffordances,
  });
