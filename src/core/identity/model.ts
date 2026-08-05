import { Schema, Struct } from "effect";
import { IanaTimeZone, Locale, ServiceMarket } from "~/core/_shared/context";
import {
  E164PhoneNumber,
  UserId,
  WhatsAppBusinessPortfolioId,
  WhatsAppBusinessScopedUserId,
  WhatsAppParentBusinessScopedUserId,
  WhatsAppUsername,
} from "./reference";

/**
 * The concrete association between a stable User and one WhatsApp caller, keyed by Business
 * Portfolio plus BSUID. Phone number, parent BSUID, and username are mutable evidence only.
 * `verifiedAt` records when an explicit association was established; later observations may
 * refresh evidence but cannot change that association. Kapso contact and message identifiers
 * remain delivery evidence only.
 */
export const WhatsAppIdentity = Schema.Struct({
  userId: UserId,
  businessPortfolioId: WhatsAppBusinessPortfolioId,
  businessScopedUserId: WhatsAppBusinessScopedUserId,
  parentBusinessScopedUserId: Schema.Option(WhatsAppParentBusinessScopedUserId),
  username: Schema.Option(WhatsAppUsername),
  phoneNumber: Schema.Option(E164PhoneNumber),
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
