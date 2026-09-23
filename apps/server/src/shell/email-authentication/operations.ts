import { HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi";
import {
  AtomicBatchEligible,
  freshWebSessionOnly,
  operationPolicy,
} from "~/shell/_shared/operation-policy";
import { OperationResponse } from "~/shell/public-http/contract";
import {
  CompleteEmailReplacementPayload,
  CompletedEmailReplacement,
  EmailReplacementFreshPairingRequiredApi,
  EmailReplacementInvalidApi,
  EmailReplacementOriginRejectedApi,
  EmailReplacementPayloadTooLargeApi,
  EmailReplacementUnsupportedMediaTypeApi,
} from "~/web-auth-api";
import { EmailReplacementPending, RequestEmailReplacementPayload } from "./contract";
import { emailReplacementCompletionPath, emailReplacementPath } from "./path";

export { EmailReplacementPending, RequestEmailReplacementPayload } from "./contract";
export { emailReplacementCompletionPath, emailReplacementPath } from "./path";

const requestEmailReplacement = HttpApiEndpoint.post(
  "requestEmailReplacement",
  emailReplacementPath,
  {
    payload: RequestEmailReplacementPayload,
    success: OperationResponse(EmailReplacementPending),
  }
)
  .annotate(
    OpenApi.Description,
    "Use after the User confirms replacing their verified email; sends a verification code to the candidate address."
  )
  // Standalone: the mailbox challenge and outbox share their own atomic unit (ADR 0027).
  .annotate(AtomicBatchEligible, false)
  .annotateMerge(
    operationPolicy({
      access: freshWebSessionOnly,
      requiredTier: "free",
      agentConfirmation: "not-required",
      kind: "mutation",
    })
  );

const completeEmailReplacement = HttpApiEndpoint.post(
  "completeEmailReplacement",
  emailReplacementCompletionPath,
  {
    payload: CompleteEmailReplacementPayload,
    success: OperationResponse(CompletedEmailReplacement),
    error: [
      EmailReplacementInvalidApi,
      EmailReplacementFreshPairingRequiredApi,
      EmailReplacementOriginRejectedApi,
      EmailReplacementPayloadTooLargeApi,
      EmailReplacementUnsupportedMediaTypeApi,
    ],
  }
)
  .annotate(
    OpenApi.Description,
    "Verify the candidate mailbox and replace the one VerifiedEmailCredential under a fresh WebSession."
  )
  // Standalone: the single-use proof and credential swap share their own atomic unit (ADR 0027).
  .annotate(AtomicBatchEligible, false)
  .annotateMerge(
    operationPolicy({
      access: freshWebSessionOnly,
      requiredTier: "free",
      agentConfirmation: "not-required",
      kind: "mutation",
    })
  );

/** Bounded verified-email account-security operations and their access policies. */
export const EmailAuthenticationGroup = HttpApiGroup.make("emailAuthentication")
  .add(requestEmailReplacement)
  .add(completeEmailReplacement);
