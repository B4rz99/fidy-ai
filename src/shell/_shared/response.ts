import * as Arr from "effect/Array";
import { Option, Schema } from "effect";
import { getBoundOperationCatalog, type CatalogOperation } from "./operation-catalog";

const englishSentenceSegmenter = new Intl.Segmenter("en", { granularity: "sentence" });

const SuggestedOperationHint = Schema.NonEmptyString.check(
  Schema.isTrimmed(),
  Schema.isMaxLength(140),
  Schema.makeFilter((hint) =>
    /[.!?]$/u.test(hint) &&
    !/[\r\n]/u.test(hint) &&
    Array.from(englishSentenceSegmenter.segment(hint)).length === 1
      ? undefined
      : { path: [], issue: "Expected one English sentence ending in punctuation" }
  )
).annotate({
  description:
    "One English sentence on why that call is worth making, no more than 140 characters. " +
    "Addressed to you, the calling agent, and not to the user — act on it rather than reading it out.",
});

/**
 * The internal carrier for reflected schema members. Handler proposals never
 * use this broad shape: `suggestOperation` binds each operation id to its input
 * at compile time, and this reflected union strictly decodes the same pairing
 * at the untyped response boundary without introducing an API assembly cycle.
 */
interface SuggestedOperationValue {
  readonly tool: string;
  readonly args?: unknown;
  readonly hint: string;
}

const suggestedOperationMember = (
  operation: CatalogOperation
): Schema.Codec<SuggestedOperationValue, SuggestedOperationValue> => {
  const tool = Schema.Literal(operation.id).annotate({
    description:
      "The canonical operation to call, spelled exactly as its `operationId` in this spec. " +
      "Look that id up here to see the complete input and result.",
  });

  return Option.match(operation.partialInput, {
    onNone: () => Schema.Struct({ tool, hint: SuggestedOperationHint }),
    onSome: (partialInput) =>
      Schema.Struct({
        tool,
        args: Schema.optionalKey(partialInput).annotate({
          description:
            "Arguments already worked out for that call. Partial by design: merge them into the " +
            "operation's own input rather than sending them as the whole of it.",
        }),
        hint: SuggestedOperationHint,
      }),
  });
};

/**
 * A suggested next canonical call. `tool` accepts exactly a published operation
 * id; `args`, when present, is that target operation's schema-derived partial
 * input.
 */
export const SuggestedOperation = Schema.suspend(() => {
  const members = getBoundOperationCatalog().operations.map(suggestedOperationMember);
  if (!Arr.isReadonlyArrayNonEmpty(members)) {
    throw new Error("SuggestedOperation requires at least one canonical operation");
  }
  return Schema.Union(members);
})
  .pipe(Schema.brand("SuggestedOperation"))
  .annotate({ identifier: "SuggestedOperation" });
export type SuggestedOperation = typeof SuggestedOperation.Type;

/**
 * The `next` field, declared once. Both success and error responses carry it on the same terms —
 * at most three suggested operations, possibly none — so a failure is as navigable
 * as a success; the error classes in `./errors` reuse this schema rather than
 * restating it.
 */
export const NextOperations = Schema.Array(SuggestedOperation)
  .check(Schema.isMaxLength(3))
  .annotate({
    description:
      "Where to go next: up to three canonical operations worth calling after this one, best " +
      "first. Empty when there is nothing worth suggesting, which is an answer rather than " +
      "an omission. Each entry has passed the target-input and caller-authorization checkpoint.",
  });

/**
 * The universal success response. Every canonical operation's success schema
 * is built with this combinator — top-level only, no per-operation opt-out.
 */
export const OperationResponse = <S extends Schema.Top>(data: S) =>
  Schema.Struct({
    data,
    next: NextOperations,
  });
