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
