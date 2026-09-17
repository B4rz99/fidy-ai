import { Schema } from "effect";
import { IanaTimeZone, Locale, ServiceMarket } from "~/core/_shared/context";

const maximumInterpretationRevisionLength = 80;

/** User and regional interpretation facts frozen when evidence is admitted. */
export const CapturedInterpretationContext = Schema.Struct({
  serviceMarket: ServiceMarket,
  locale: Locale,
  timeZone: IanaTimeZone,
}).annotate({ identifier: "CapturedInterpretationContext" });
export type CapturedInterpretationContext = typeof CapturedInterpretationContext.Type;

/** Names one bounded parser, extractor, or interpretation contract. */
export const InterpretationRevision = Schema.NonEmptyString.check(
  Schema.isTrimmed(),
  Schema.isMaxLength(maximumInterpretationRevisionLength)
)
  .pipe(Schema.brand("InterpretationRevision"))
  .annotate({ identifier: "InterpretationRevision" });
export type InterpretationRevision = typeof InterpretationRevision.Type;
