import { Schema } from "effect";

/** Stable internal identity of one bounded pre-User mailbox enrollment. */
export const EmailEnrollmentId = Schema.String.check(Schema.isUUID())
  .pipe(Schema.brand("EmailEnrollmentId"))
  .annotate({ identifier: "EmailEnrollmentId" });
export type EmailEnrollmentId = typeof EmailEnrollmentId.Type;
