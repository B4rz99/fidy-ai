import { Duration, Schema, Struct } from "effect";
import { IanaTimeZone, Locale, ServiceMarket } from "~/core/_shared/context";
import { UtcTimestamp } from "~/core/_shared/time";

const maximumBusinessPortfolioIdLength = 128;
const maximumWhatsAppUsernameLength = 256;

/**
 * The identity every slice references when it needs to say whose data this is.
 *
 * A stable surrogate id independent of channel identities and credentials.
 * WhatsAppIdentity belongs to the identity slice's own record, so changing a
 * BSUID, phone number, or username does not rewrite tables that point at the same User.
 *
 * Ownership is context, not a field (ARCHITECTURE.md §5), so this appears in
 * repo and core signatures and in storage — never as a field on an ordinary
 * entity's schema, where a client could name it.
 */
export const UserId = Schema.String.check(Schema.isUUID())
  .pipe(Schema.brand("UserId"))
  .annotate({ identifier: "UserId" });
export type UserId = typeof UserId.Type;

/**
 * A WhatsApp phone number in canonical E.164 form: one leading `+`, a
 * non-zero country-code digit, and 8–15 digits total. Formatting characters
 * and locally scoped numbers are rejected so database uniqueness has one
 * spelling per number.
 */
export const E164PhoneNumber = Schema.String.check(Schema.isPattern(/^\+[1-9][0-9]{7,14}$/))
  .pipe(Schema.brand("E164PhoneNumber"))
  .annotate({ identifier: "E164PhoneNumber" });
export type E164PhoneNumber = typeof E164PhoneNumber.Type;

/**
 * Trimmed, non-empty Meta Business Portfolio identifier, limited to 128 characters. It scopes
 * every BSUID and must come from trusted deployment configuration rather than webhook payloads.
 */
export const WhatsAppBusinessPortfolioId = Schema.NonEmptyString.check(
  Schema.isTrimmed(),
  Schema.isMaxLength(maximumBusinessPortfolioIdLength)
)
  .pipe(Schema.brand("WhatsAppBusinessPortfolioId"))
  .annotate({ identifier: "WhatsAppBusinessPortfolioId" });
export type WhatsAppBusinessPortfolioId = typeof WhatsAppBusinessPortfolioId.Type;

/**
 * Meta's stable WhatsApp caller key within one Business Portfolio. Accepted values consist of a
 * two-letter market prefix, a dot, and 1–128 alphanumeric characters.
 */
export const WhatsAppBusinessScopedUserId = Schema.String.check(
  Schema.isPattern(/^[A-Z]{2}\.[A-Za-z0-9]{1,128}$/iu)
)
  .pipe(Schema.brand("WhatsAppBusinessScopedUserId"))
  .annotate({ identifier: "WhatsAppBusinessScopedUserId" });
export type WhatsAppBusinessScopedUserId = typeof WhatsAppBusinessScopedUserId.Type;

/** Business sender identifier required to route a WhatsApp reply. */
export const WhatsAppBusinessPhoneNumberId = Schema.String.check(
  Schema.isPattern(/^[0-9]{1,32}$/u)
).pipe(Schema.brand("WhatsAppBusinessPhoneNumberId"));
export type WhatsAppBusinessPhoneNumberId = typeof WhatsAppBusinessPhoneNumberId.Type;

/**
 * Optional cross-portfolio evidence available only to enrolled managed businesses. It follows
 * Meta's two-letter market, `.ENT.`, and 1–128 alphanumeric identifier format and never resolves a
 * Fidy User.
 */
export const WhatsAppParentBusinessScopedUserId = Schema.String.check(
  Schema.isPattern(/^[A-Z]{2}\.ENT\.[A-Za-z0-9]{1,128}$/iu)
)
  .pipe(Schema.brand("WhatsAppParentBusinessScopedUserId"))
  .annotate({ identifier: "WhatsAppParentBusinessScopedUserId" });
export type WhatsAppParentBusinessScopedUserId = typeof WhatsAppParentBusinessScopedUserId.Type;

/**
 * Trimmed, non-empty WhatsApp username of at most 256 characters. It is mutable display evidence
 * and never caller-resolution authority.
 */
export const WhatsAppUsername = Schema.NonEmptyString.check(
  Schema.isTrimmed(),
  Schema.isMaxLength(maximumWhatsAppUsernameLength)
)
  .pipe(Schema.brand("WhatsAppUsername"))
  .annotate({ identifier: "WhatsAppUsername" });
export type WhatsAppUsername = typeof WhatsAppUsername.Type;

/** Stable cross-slice reference to one WhatsApp caller within a trusted Business Portfolio. */
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

/**
 * TrialPeriod is the immutable, half-open [startedAt, endsAt) interval for a User's single
 * no-card Pro trial. endsAt must be exactly 168 hours after startedAt.
 */
export const TrialPeriod = TrialPeriodFields.check(exactTrialDuration).annotate({
  identifier: "TrialPeriod",
});
export type TrialPeriod = typeof TrialPeriod.Type;

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

/** Independently stored interpretation context for one User, without identity or credential data. */
export const UserContext = User.mapFields(
  Struct.pick(["serviceMarket", "locale", "timeZone"])
).annotate({ identifier: "UserContext" });
export type UserContext = typeof UserContext.Type;
