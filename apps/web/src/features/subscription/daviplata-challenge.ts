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
  remember: (allowed: boolean) => boolean
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
      const retrySubmission = remember(outcome.status === "uncertain" && outcome.retrySubmission);
      return { status: "uncertain", retrySubmission } as const;
    });

const recoverSubmission = (
  input: ChallengeInput,
  retired: () => boolean,
  remember: (allowed: boolean) => boolean
): Promise<DaviplataConfirmation> =>
  retired() ? Promise.resolve({ status: "refused" }) : submissionUncertainty(input, remember);

const unapprovedOutcome = (
  approved: boolean,
  outcome: Exclude<DaviplataProviderOutcome, { status: "approved" | "uncertain" }>
): Promise<DaviplataConfirmation> =>
  Promise.resolve(approved ? { status: "uncertain", retrySubmission: false } : outcome);

const consumeOtp = (
  otp: Redacted.Redacted<string>,
  confirm: (owned: Redacted.Redacted<string>) => Promise<DaviplataConfirmation>,
  pending: Set<Redacted.Redacted<string>>
): Promise<DaviplataConfirmation> => {
  const owned = Redacted.make(Redacted.value(otp));
  Redacted.wipeUnsafe(otp);
  pending.add(owned);
  return confirm(owned).finally(() => {
    Redacted.wipeUnsafe(owned);
    pending.delete(owned);
  });
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

type ChallengeControl = Readonly<{
  approved: () => boolean;
  busy: () => boolean;
  retryAllowed: () => boolean;
  pendingOtp: Set<Redacted.Redacted<string>>;
  dispose: () => void;
}>;
const bindActions = (
  input: ChallengeInput,
  execute: (action: Effect.Effect<DaviplataProviderOutcome>) => Promise<DaviplataConfirmation>,
  control: ChallengeControl
): DaviplataChallenge => ({
  resend: () =>
    control.approved() ? Promise.resolve({ status: "refused" }) : execute(input.provider.resend()),
  confirm: (otp) =>
    consumeOtp(
      otp,
      (owned) =>
        control.approved()
          ? Promise.resolve({ status: "refused" })
          : execute(input.provider.confirm(owned)),
      control.pendingOtp
    ),
  retrySubmission: () => {
    if (control.busy()) return Promise.resolve({ status: "busy" });
    return control.retryAllowed()
      ? execute(input.provider.retrySubmission())
      : Promise.resolve({ status: "refused" });
  },
  dispose: control.dispose,
});

/** Encloses provider approval and projects only safe submission outcomes for the mounted form. */
export const makeDaviplataChallenge = (input: ChallengeInput): DaviplataChallenge => {
  const controller = new AbortController();
  const signal = AbortSignal.any([controller.signal, input.provider.signal, input.client.signal]);
  const pendingOtp = new Set<Redacted.Redacted<string>>();
  signal.addEventListener("abort", () => pendingOtp.forEach(Redacted.wipeUnsafe), { once: true });
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
        recoverSubmission(
          input,
          () => disposed,
          (allowed) => {
            retryAllowed = !disposed && !signal.aborted && allowed;
            return retryAllowed;
          }
        )
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
  return bindActions(input, execute, {
    approved: () => approved,
    busy: () => busy,
    retryAllowed: () => retryAllowed,
    pendingOtp,
    dispose,
  });
};
