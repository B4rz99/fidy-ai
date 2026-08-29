import { Schema } from "effect";

const maximumInterpretationRevisionLength = 80;

/** Names one bounded parser, extractor, or interpretation contract. */
export const InterpretationRevision = Schema.NonEmptyString.check(
  Schema.isTrimmed(),
  Schema.isMaxLength(maximumInterpretationRevisionLength)
)
  .pipe(Schema.brand("InterpretationRevision"))
  .annotate({ identifier: "InterpretationRevision" });
export type InterpretationRevision = typeof InterpretationRevision.Type;
