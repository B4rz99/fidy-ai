import { Duration, Schema, Struct } from "effect";
import { IanaTimeZone, Locale, ServiceMarket } from "~/core/_shared/context";
import { UtcTimestamp } from "~/core/_shared/time";

const maximumBusinessPortfolioIdLength = 128;

const maximumWhatsAppUsernameLength = 256;

export const UserId = Schema.String.check(Schema.isUUID())
  .pipe(Schema.brand("UserId"))
  .annotate({ identifier: "UserId" });

export type UserId = typeof UserId.Type;

export const E164PhoneNumber = Schema.String.check(Schema.isPattern(/^\+[1-9][0-9]{7,14}$/))
  .pipe(Schema.brand("E164PhoneNumber"))
  .annotate({ identifier: "E164PhoneNumber" });

export type E164PhoneNumber = typeof E164PhoneNumber.Type;

export const WhatsAppBusinessPortfolioId = Schema.NonEmptyString.check(
  Schema.isTrimmed(),
  Schema.isMaxLength(maximumBusinessPortfolioIdLength)
)
  .pipe(Schema.brand("WhatsAppBusinessPortfolioId"))
  .annotate({ identifier: "WhatsAppBusinessPortfolioId" });

export type WhatsAppBusinessPortfolioId = typeof WhatsAppBusinessPortfolioId.Type;

export const WhatsAppBusinessScopedUserId = Schema.String.check(
  Schema.isPattern(/^[A-Z]{2}\.[A-Za-z0-9]{1,128}$/iu)
)
  .pipe(Schema.brand("WhatsAppBusinessScopedUserId"))
  .annotate({ identifier: "WhatsAppBusinessScopedUserId" });

export type WhatsAppBusinessScopedUserId = typeof WhatsAppBusinessScopedUserId.Type;

export const WhatsAppBusinessPhoneNumberId = Schema.String.check(
  Schema.isPattern(/^[0-9]{1,32}$/u)
).pipe(Schema.brand("WhatsAppBusinessPhoneNumberId"));

export type WhatsAppBusinessPhoneNumberId = typeof WhatsAppBusinessPhoneNumberId.Type;

export const WhatsAppParentBusinessScopedUserId = Schema.String.check(
  Schema.isPattern(/^[A-Z]{2}\.ENT\.[A-Za-z0-9]{1,128}$/iu)
)
  .pipe(Schema.brand("WhatsAppParentBusinessScopedUserId"))
  .annotate({ identifier: "WhatsAppParentBusinessScopedUserId" });

export type WhatsAppParentBusinessScopedUserId = typeof WhatsAppParentBusinessScopedUserId.Type;

export const WhatsAppUsername = Schema.NonEmptyString.check(
  Schema.isTrimmed(),
  Schema.isMaxLength(maximumWhatsAppUsernameLength)
)
  .pipe(Schema.brand("WhatsAppUsername"))
  .annotate({ identifier: "WhatsAppUsername" });

export type WhatsAppUsername = typeof WhatsAppUsername.Type;

export const WhatsAppCallerReference = Schema.Struct({
  businessPortfolioId: WhatsAppBusinessPortfolioId,
  businessScopedUserId: WhatsAppBusinessScopedUserId,
}).annotate({ identifier: "WhatsAppCallerReference" });

export type WhatsAppCallerReference = typeof WhatsAppCallerReference.Type;

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

export const TrialPeriod = TrialPeriodFields.check(exactTrialDuration).annotate({
  identifier: "TrialPeriod",
});

export type TrialPeriod = typeof TrialPeriod.Type;

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

export const User = Schema.Struct({
  id: UserId,
  serviceMarket: ServiceMarket,
  locale: Locale,
  timeZone: IanaTimeZone,
  trialPeriod: TrialPeriod,
  createdAt: UtcTimestamp,
}).annotate({ identifier: "User" });

export type User = typeof User.Type;

export const UserPreferences = User.mapFields(Struct.pick(["locale", "timeZone"])).annotate({
  identifier: "UserPreferences",
});

export type UserPreferences = typeof UserPreferences.Type;

export const UserContext = User.mapFields(
  Struct.pick(["serviceMarket", "locale", "timeZone"])
).annotate({ identifier: "UserContext" });

export type UserContext = typeof UserContext.Type;
