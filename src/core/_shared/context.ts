import { DateTime, Option, Schema } from "effect";

/**
 * A jurisdiction where fidy's product, providers, terms, and compliance
 * behavior are enabled. Colombia is the sole supported value; Currency, locale,
 * time zone, and channel never determine it.
 */
export const ServiceMarket = Schema.Literal("CO").annotate({
  identifier: "ServiceMarket",
});
export type ServiceMarket = typeof ServiceMarket.Type;

/**
 * A supported presentation locale. Presentation is Spanish for Colombia only,
 * and this value never supplies monetary or market meaning.
 */
export const Locale = Schema.Literal("es-CO").annotate({ identifier: "Locale" });
export type Locale = typeof Locale.Type;

/**
 * A named IANA time-zone identifier accepted by the running JavaScript time-zone
 * database. Fixed offsets are excluded because schedules and calendar queries
 * need a durable named zone whose daylight-saving rules can be applied later.
 */
export const IanaTimeZone = Schema.String.check(
  Schema.makeFilter((timeZone) =>
    !timeZone.startsWith("+") &&
    !timeZone.startsWith("-") &&
    Option.isSome(DateTime.zoneMakeNamed(timeZone))
      ? undefined
      : { path: [], issue: "Expected a valid named IANA time zone" }
  )
)
  .pipe(Schema.brand("IanaTimeZone"))
  .annotate({ identifier: "IanaTimeZone" });
export type IanaTimeZone = typeof IanaTimeZone.Type;
