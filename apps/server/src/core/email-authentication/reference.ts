import { Schema } from "effect";

const maximumEmailAddressLength = 254;
const mailboxGrammar =
  /^[a-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[a-z0-9!#$%&'*+/=?^_`{|}~-]+)*@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/u;

/** Public canonical mailbox checks shared by slices that own email-shaped values. */
export const canonicalEmailAddressChecks = [
  Schema.isNonEmpty(),
  Schema.isLowercased(),
  Schema.isMaxLength(maximumEmailAddressLength),
  Schema.isPattern(mailboxGrammar),
] as const;

/** Stable internal identity of one bounded pre-User mailbox enrollment. */
export const EmailEnrollmentId = Schema.String.check(Schema.isUUID())
  .pipe(Schema.brand("EmailEnrollmentId"))
  .annotate({ identifier: "EmailEnrollmentId" });
export type EmailEnrollmentId = typeof EmailEnrollmentId.Type;
