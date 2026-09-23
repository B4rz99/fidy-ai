import { Schema } from "effect";
import { EmailAddress } from "~/core/email-authentication/model";

/** Candidate mailbox supplied for one verified-email replacement request. */
export const RequestEmailReplacementPayload = Schema.Struct({
  candidateEmail: EmailAddress,
}).annotate({ identifier: "RequestEmailReplacementPayload" });

/** Uniform response after a replacement request is accepted or safely suppressed. */
export const EmailReplacementPending = Schema.Struct({
  status: Schema.Literal("pending"),
}).annotate({ identifier: "EmailReplacementPending" });
