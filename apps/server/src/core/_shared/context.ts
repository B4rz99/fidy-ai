import { DateTime, Option, Schema } from "effect";

export const ServiceMarket = Schema.Literal("CO").annotate({
  identifier: "ServiceMarket",
});

export type ServiceMarket = typeof ServiceMarket.Type;

export const Locale = Schema.Literal("es-CO").annotate({ identifier: "Locale" });

export type Locale = typeof Locale.Type;

export const IanaTimeZone = Schema.String.check(
  Schema.makeFilter((timeZone) =>
    !timeZone.startsWith("+") &&
    !timeZone.startsWith("-") &&
    Option.isSome(DateTime.zoneMakeNamed(timeZone))
      ? undefined
      : "Expected a valid named IANA time zone"
  )
)
  .pipe(Schema.brand("IanaTimeZone"))
  .annotate({ identifier: "IanaTimeZone" });

export type IanaTimeZone = typeof IanaTimeZone.Type;
