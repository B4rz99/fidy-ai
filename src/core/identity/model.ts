import { Schema, Struct } from "effect";
import { IanaTimeZone, Locale, ServiceMarket } from "~/core/_shared/context";
import { E164PhoneNumber, UserId } from "./reference";

/**
 * The concrete verified association between a stable User and their current
 * WhatsApp phone number. Provider contact or message identifiers are absent
 * because they are delivery evidence, never identity.
 */
export const WhatsAppIdentity = Schema.Struct({
  userId: UserId,
  phoneNumber: E164PhoneNumber,
  verifiedAt: Schema.DateTimeUtc,
}).annotate({ identifier: "WhatsAppIdentity" });
export type WhatsAppIdentity = typeof WhatsAppIdentity.Type;

/**
 * A User's stable identity and current interpretation context. The three
 * context fields are independent persisted values: none may be inferred from
 * a phone number, Currency, channel, or either of the other fields.
 */
export const User = Schema.Struct({
  id: UserId,
  serviceMarket: ServiceMarket,
  locale: Locale,
  timeZone: IanaTimeZone,
  createdAt: Schema.DateTimeUtc,
}).annotate({ identifier: "User" });
export type User = typeof User.Type;

/**
 * The current presentation preferences a User may change. ServiceMarket is
 * deliberately absent: changing product jurisdiction is not an ordinary
 * preference operation.
 */
export const UserPreferences = User.mapFields(Struct.pick(["locale", "timeZone"])).annotate({
  identifier: "UserPreferences",
});
export type UserPreferences = typeof UserPreferences.Type;
