import { Duration, Schema, Struct } from "effect";
import { IanaTimeZone, Locale, ServiceMarket } from "~/core/_shared/context";
import {
  E164PhoneNumber,
  UserId,
  WhatsAppBusinessPortfolioId,
  WhatsAppBusinessScopedUserId,
  WhatsAppParentBusinessScopedUserId,
  WhatsAppUsername,
} from "./reference";
import { UtcTimestamp } from "~/core/_shared/time";

const trialHours = 168;
const sevenDaysInMilliseconds = Duration.toMillis(Duration.hours(trialHours));
const TrialPeriodFields = Schema.Struct({
  startedAt: UtcTimestamp,
  endsAt: UtcTimestamp,
});
const exactTrialDuration = Schema.makeFilter<typeof TrialPeriodFields.Type>((period) =>
  period.endsAt.epochMilliseconds - period.startedAt.epochMilliseconds === sevenDaysInMilliseconds
    ? undefined
    : { path: ["endsAt"], issue: "Expected exactly 168 hours after startedAt" }
);

/**
 * TrialPeriod is the immutable, half-open [startedAt, endsAt) interval for a User's single
 * no-card Pro trial. endsAt must be exactly 168 hours after startedAt.
 */
export const TrialPeriod = TrialPeriodFields.check(exactTrialDuration).annotate({
  identifier: "TrialPeriod",
});
export type TrialPeriod = typeof TrialPeriod.Type;

/**
 * PaidTier records whether the User has no paid Subscription (`free`) or an active Pro
 * Subscription (`pro`); TrialPeriod does not alter it.
 */
export const PaidTier = Schema.Literals(["free", "pro"]);
export type PaidTier = typeof PaidTier.Type;

/** Free or Pro access after applying both PaidTier and TrialPeriod. */
export const EffectiveAccess = Schema.Literals(["free", "pro"]);
export type EffectiveAccess = typeof EffectiveAccess.Type;

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
  verifiedAt: UtcTimestamp,
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
  paidTier: PaidTier,
  trialPeriod: TrialPeriod,
  createdAt: UtcTimestamp,
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
