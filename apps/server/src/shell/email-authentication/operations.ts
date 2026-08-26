import { Schema } from "effect";
import { HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi";
import { EmailAddress } from "~/core/email-authentication/model";
import {
  freshWebOrVerifiedWhatsAppHosted,
  operationPolicy,
} from "~/shell/_shared/operation-policy";
import { OperationResponse } from "~/shell/_shared/response";

/** Candidate mailbox supplied for one verified-email replacement request. */
export const RequestEmailReplacementPayload = Schema.Struct({
  candidateEmail: EmailAddress,
}).annotate({ identifier: "RequestEmailReplacementPayload" });

/** Uniform response after a replacement request is accepted or safely suppressed. */
export const EmailReplacementPending = Schema.Struct({
  status: Schema.Literal("pending"),
}).annotate({ identifier: "EmailReplacementPending" });

const requestEmailReplacement = HttpApiEndpoint.post(
  "requestEmailReplacement",
  "/email/replacement",
  {
    payload: RequestEmailReplacementPayload,
    success: OperationResponse(EmailReplacementPending),
  }
)
  .annotate(
    OpenApi.Description,
    "Use after the User confirms replacing their verified email; sends a verification code to the candidate address."
  )
  .annotateMerge(
    operationPolicy({
      access: freshWebOrVerifiedWhatsAppHosted,
      requiredTier: "free",
      agentConfirmation: "required",
      kind: "mutation",
    })
  );

/** Bounded verified-email account-security operations and their access policies. */
export const EmailAuthenticationGroup =
  HttpApiGroup.make("emailAuthentication").add(requestEmailReplacement);
