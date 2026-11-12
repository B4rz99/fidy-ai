import { Data, Effect, Redacted } from "effect";
import { type Mock, afterEach, expect, it, vi } from "vitest";
import {
  PaymentEnrollmentId,
  type PaymentSubmissionType,
  makeSubscriptionEnrollmentClient,
} from "@/transport/client";
import {
  type DaviplataProviderChallenge,
  type DaviplataProviderOutcome,
} from "@/transport/wompi-daviplata";
import { makeDaviplataChallenge } from "./daviplata-challenge";

class TestBoundaryFailure extends Data.TaggedError("TestBoundaryFailure")<{}> {}
const fromPromise = <A>(thunk: () => Promise<A>): Effect.Effect<A, TestBoundaryFailure> =>
  Effect.tryPromise({ try: thunk, catch: () => new TestBoundaryFailure() });
const clients: Array<ReturnType<typeof makeSubscriptionEnrollmentClient>> = [];
afterEach(() =>
  Effect.runPromise(
    Effect.forEach(clients.splice(0), (client) => fromPromise(() => client.dispose()))
  )
);
const submission: PaymentSubmissionType = {
  status: "source-verifying",
  enrollmentId: PaymentEnrollmentId.make("23200000-0000-4000-8000-000000000001"),
};
const approval = (): DaviplataProviderOutcome => ({
  status: "approved",
  token: Redacted.make("synthetic-approved-token"),
});
type ChallengeFixture = Readonly<{
  client: ReturnType<typeof makeSubscriptionEnrollmentClient>;
  provider: DaviplataProviderChallenge;
  submitApproved: Mock<(token: Redacted.Redacted<string>) => Promise<PaymentSubmissionType>>;
}>;
const fixture = (overrides: Partial<DaviplataProviderChallenge> = {}): ChallengeFixture => {
  const client = makeSubscriptionEnrollmentClient({ apiOrigin: "https://api.test.fidyapp.com" });
  clients.push(client);
  const provider: DaviplataProviderChallenge = {
    signal: new AbortController().signal,
    resend: vi.fn(() => Effect.succeed({ status: "retry-allowed" } as const)),
    confirm: vi.fn(() => Effect.succeed(approval())),
    retrySubmission: vi.fn(() => Effect.succeed(approval())),
    dispose: vi.fn(),
    ...overrides,
  };
  const submitApproved = vi.fn((_token: Redacted.Redacted<string>) => Promise.resolve(submission));
  return { client, provider, submitApproved };
};

it("contains provider execution failure and wipes the OTP without submitting", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const input = fixture({ confirm: () => Effect.die(new Error("Synthetic provider failure")) });
      const challenge = makeDaviplataChallenge(input);
      const otp = Redacted.make("574829");
      expect(yield* fromPromise(() => challenge.confirm(otp))).toEqual({
        status: "uncertain",
        retrySubmission: false,
      });
      expect(() => Redacted.value(otp)).toThrow();
      expect(input.submitApproved).not.toHaveBeenCalled();
      challenge.dispose();
    })
  ));

it("disables recovery when a defective provider cannot inspect retained approval after submission failure", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const input = fixture({
        retrySubmission: () => Effect.die(new Error("Synthetic authority failure")),
      });
      input.submitApproved.mockRejectedValue(new TestBoundaryFailure());
      const challenge = makeDaviplataChallenge(input);
      expect(yield* fromPromise(() => challenge.confirm(Redacted.make("574829")))).toEqual({
        status: "uncertain",
        retrySubmission: false,
      });
      expect(input.submitApproved).toHaveBeenCalledTimes(1);
      expect(yield* fromPromise(() => challenge.resend())).toEqual({ status: "refused" });
      challenge.dispose();
    })
  ));

it("keeps approved submission busy until uncertainty settles before granting a same-request retry", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const input = fixture();
      const pending = Promise.withResolvers<PaymentSubmissionType>();
      input.submitApproved.mockReturnValueOnce(pending.promise);
      const challenge = makeDaviplataChallenge(input);
      const confirming = challenge.confirm(Redacted.make("574829"));
      yield* Effect.yieldNow;
      expect(yield* fromPromise(() => challenge.retrySubmission())).toEqual({ status: "busy" });
      expect(input.provider.retrySubmission).not.toHaveBeenCalled();
      pending.reject(new TestBoundaryFailure());
      expect(yield* fromPromise(() => confirming)).toEqual({
        status: "uncertain",
        retrySubmission: true,
      });
      expect(yield* fromPromise(() => challenge.retrySubmission())).toEqual({
        status: "submitted",
        submission,
      });
      expect(input.submitApproved).toHaveBeenCalledTimes(2);
    })
  ));

it("keeps a lost approved submission uncertain when its retry authority later expires", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const retry = vi.fn<DaviplataProviderChallenge["retrySubmission"]>(() =>
        Effect.succeed(approval())
      );
      const input = fixture({ retrySubmission: retry });
      input.submitApproved.mockRejectedValue(new TestBoundaryFailure());
      const challenge = makeDaviplataChallenge(input);
      expect(yield* fromPromise(() => challenge.confirm(Redacted.make("574829")))).toEqual({
        status: "uncertain",
        retrySubmission: true,
      });
      retry.mockImplementation(() => Effect.succeed({ status: "refused" }));
      expect(yield* fromPromise(() => challenge.retrySubmission())).toEqual({
        status: "uncertain",
        retrySubmission: false,
      });
      expect(input.submitApproved).toHaveBeenCalledTimes(1);
      challenge.dispose();
    })
  ));

it("consumes supplied OTP immediately and fences a submitted result after disposal", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const input = fixture();
      const pending = Promise.withResolvers<PaymentSubmissionType>();
      input.submitApproved.mockReturnValue(pending.promise);
      const challenge = makeDaviplataChallenge(input);
      const otp = Redacted.make("574829");
      const confirming = challenge.confirm(otp);
      expect(() => Redacted.value(otp)).toThrow();
      yield* Effect.yieldNow;
      challenge.dispose();
      const ownedOtp = vi.mocked(input.provider.confirm).mock.calls[0]?.[0];
      expect(ownedOtp).toBeDefined();
      if (ownedOtp !== undefined) expect(() => Redacted.value(ownedOtp)).toThrow();
      pending.resolve(submission);
      expect(yield* fromPromise(() => confirming)).toEqual({ status: "refused" });
      expect(yield* fromPromise(() => challenge.retrySubmission())).toEqual({ status: "refused" });
    })
  ));
