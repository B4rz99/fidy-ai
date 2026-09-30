import { Option, Schema } from "effect";
import { UserContext } from "../../../src/core/identity/contract";
import type { PreparedIdentityRead, UserContextInput } from "../contract";

const ContextRow = Schema.Struct({
  service_market: UserContext.fields.serviceMarket,
  locale: UserContext.fields.locale,
  time_zone: UserContext.fields.timeZone,
});

export const prepareContext = ({
  db,
  userId,
}: UserContextInput): PreparedIdentityRead<UserContext> => ({
  statement: db
    .prepare("SELECT service_market, locale, time_zone FROM users WHERE id = ?")
    .bind(userId),
  decode: (raw: unknown): Option.Option<UserContext> =>
    Option.map(Schema.decodeUnknownOption(ContextRow)(raw), (row) => ({
      serviceMarket: row.service_market,
      locale: row.locale,
      timeZone: row.time_zone,
    })),
});
