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
  submitApproved: (
    token: Redacted.Redacted<string>,
    signal: AbortSignal
  ) => Promise<PaymentSubmissionType>;
}>;
const unknownAuthorization = (): Promise<DaviplataConfirmation> =>
  Promise.resolve({ status: "uncertain", retrySubmission: false });
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

const consumeOtp = (
  otp: Redacted.Redacted<string>,
  confirm: (owned: Redacted.Redacted<string>) => Promise<DaviplataConfirmation>
): Promise<DaviplataConfirmation> => {
  const owned = Redacted.make(Redacted.value(otp));
  Redacted.wipeUnsafe(otp);
  return confirm(owned).finally(() => Redacted.wipeUnsafe(owned));
};

const submittedOutcome = (
  submission: PaymentSubmissionType,
  live: () => boolean,
  dispose: () => void
): DaviplataConfirmation => {
  if (!live()) return { status: "refused" };
  dispose();
  return { status: "submitted", submission };
};

/** Encloses provider approval and projects only safe submission outcomes for the mounted form. */
export const makeDaviplataChallenge = (input: ChallengeInput): DaviplataChallenge => {
  const controller = new AbortController();
  const signal = AbortSignal.any([controller.signal, input.provider.signal, input.client.signal]);
  let disposed = false;
  let busy = false;
  let approved = false;
  let retryAllowed = false;
  const dispose = (): void => {
    disposed = true;
    controller.abort();
    retryAllowed = false;
    input.provider.dispose();
  };
  const apply = (outcome: DaviplataProviderOutcome): Promise<DaviplataConfirmation> => {
    if (outcome.status === "uncertain") return unknownAuthorization();
    if (disposed || signal.aborted) return Promise.resolve({ status: "refused" });
    if (outcome.status !== "approved") return unapprovedOutcome(approved, outcome);
    approved = true;
    retryAllowed = false;
    return input.submitApproved(outcome.token, signal).then(
      (submission) => submittedOutcome(submission, () => !disposed && !signal.aborted, dispose),
      () =>
        disposed
          ? Promise.resolve({ status: "refused" } as const)
          : submissionUncertainty(input, (allowed) => {
              retryAllowed = !disposed && !signal.aborted && allowed;
            })
    );
  };
  const execute = (
    action: Effect.Effect<DaviplataProviderOutcome>
  ): Promise<DaviplataConfirmation> => {
    if (disposed || signal.aborted) return Promise.resolve({ status: "refused" });
    if (busy) return Promise.resolve({ status: "busy" });
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
      consumeOtp(otp, (owned) =>
        approved ? Promise.resolve({ status: "refused" }) : execute(input.provider.confirm(owned))
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
