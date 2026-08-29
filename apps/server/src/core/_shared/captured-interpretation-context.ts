import { Schema } from "effect";
import { IanaTimeZone, Locale, ServiceMarket } from "./context";

/** User and regional interpretation facts frozen when evidence is admitted. */
export const CapturedInterpretationContext = Schema.Struct({
  serviceMarket: ServiceMarket,
  locale: Locale,
  timeZone: IanaTimeZone,
}).annotate({ identifier: "CapturedInterpretationContext" });
export type CapturedInterpretationContext = typeof CapturedInterpretationContext.Type;
