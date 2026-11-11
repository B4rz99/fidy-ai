import { type Effect, Redacted } from "effect";
import { type PaymentSubmissionType, type SubscriptionEnrollmentClient } from "@/transport/client";
import {
  type DaviplataProviderChallenge,
  type DaviplataProviderOutcome,
} from "@/transport/wompi-daviplata";

export type DaviplataConfirmation =
  | Readonly<{ status: "retry-allowed" }>
  | Readonly<{ status: "busy" }>
  | Readonly<{ status: "submitted"; submission: PaymentSubmissionType }>
  | Readonly<{ status: "refused" }>
  | Readonly<{ status: "uncertain"; retrySubmission: boolean }>;
/**
 * Mounted authorization capability. OTPs are consumed; provider authority never leaves this closure.
 * Uncertain authorization cannot resume. An uncertain Fidy submission may be explicitly retried
 * within the original authorization lifetime, with the same PaymentRequestId and no new OTP call.
 */
export type DaviplataChallenge = Readonly<{
  resend: () => Promise<DaviplataConfirmation>;
  confirm: (otp: Redacted.Redacted<string>) => Promise<DaviplataConfirmation>;
  retrySubmission: () => Promise<DaviplataConfirmation>;
  dispose: () => void;
}>;
type ChallengeInput = Readonly<{
  provider: DaviplataProviderChallenge;
  client: SubscriptionEnrollmentClient;
  submitApproved: (token: Redacted.Redacted<string>) => Promise<PaymentSubmissionType>;
}>;
const wipeOtpAfterConfirmation = (
  otp: Redacted.Redacted<string>,
  result: Promise<DaviplataConfirmation>
): Promise<DaviplataConfirmation> =>
  result.finally(() => {
    Redacted.wipeUnsafe(otp);
  });
const submissionUncertainty = (
  input: ChallengeInput,
  remember: (allowed: boolean) => void
): Promise<DaviplataConfirmation> =>
  input.client
    .execute(() => input.provider.retrySubmission())
    .then(
      (outcome): DaviplataConfirmation => ({
        status: "uncertain",
        retrySubmission: outcome.status === "approved",
      }),
      (): DaviplataConfirmation => ({ status: "uncertain", retrySubmission: false })
    )
    .then((outcome) => {
      remember(outcome.status === "uncertain" && outcome.retrySubmission);
      return outcome;
    });

const unapprovedOutcome = (
  approved: boolean,
  outcome: Exclude<DaviplataProviderOutcome, { status: "approved" | "uncertain" }>
): Promise<DaviplataConfirmation> =>
  Promise.resolve(approved ? { status: "uncertain", retrySubmission: false } : outcome);

/** Encloses provider approval and projects only safe submission outcomes for the mounted form. */
export const makeDaviplataChallenge = (input: ChallengeInput): DaviplataChallenge => {
  let disposed = false;
  let busy = false;
  let approved = false;
  let retryAllowed = false;
  const dispose = (): void => {
    disposed = true;
    input.provider.dispose();
  };
  const apply = (outcome: DaviplataProviderOutcome): Promise<DaviplataConfirmation> => {
    if (outcome.status === "uncertain") {
      return Promise.resolve({ status: "uncertain", retrySubmission: false });
    }
    if (outcome.status !== "approved") return unapprovedOutcome(approved, outcome);
    approved = true;
    retryAllowed = false;
    return input.submitApproved(outcome.token).then(
      (submission): DaviplataConfirmation => {
        dispose();
        return { status: "submitted", submission };
      },
      () =>
        submissionUncertainty(input, (allowed) => {
          retryAllowed = allowed;
        })
    );
  };
  const execute = (
    action: Effect.Effect<DaviplataProviderOutcome>
  ): Promise<DaviplataConfirmation> => {
    if (disposed || input.client.signal.aborted) return Promise.resolve({ status: "refused" });
    if (busy) {
      return Promise.resolve({ status: "busy" });
    }
    busy = true;
    retryAllowed = false;
    return input.client
      .execute(() => action)
      .then(apply, (): DaviplataConfirmation => ({ status: "uncertain", retrySubmission: false }))
      .finally(() => {
        busy = false;
      });
  };
  return {
    resend: () =>
      approved ? Promise.resolve({ status: "refused" }) : execute(input.provider.resend()),
    confirm: (otp) =>
      wipeOtpAfterConfirmation(
        otp,
        approved ? Promise.resolve({ status: "refused" }) : execute(input.provider.confirm(otp))
      ),
    retrySubmission: () => {
      if (busy) return Promise.resolve({ status: "busy" });
      return retryAllowed
        ? execute(input.provider.retrySubmission())
        : Promise.resolve({ status: "refused" });
    },
    dispose,
  };
};
