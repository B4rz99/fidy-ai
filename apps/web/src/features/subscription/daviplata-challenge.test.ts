import { Data, Deferred, Effect, Redacted } from "effect";
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

it("allows a new OTP after a retryable refusal without submitting provider authority", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const input = fixture({
        confirm: vi.fn(() => Effect.succeed({ status: "retry-allowed" } as const)),
      });
      const challenge = makeDaviplataChallenge(input);
      const otp = Redacted.make("574829");
      expect(yield* fromPromise(() => challenge.confirm(otp))).toEqual({ status: "retry-allowed" });
      expect(() => Redacted.value(otp)).toThrow();
      expect(yield* fromPromise(() => challenge.resend())).toEqual({ status: "retry-allowed" });
      expect(input.submitApproved).not.toHaveBeenCalled();
      expect(yield* fromPromise(() => challenge.retrySubmission())).toEqual({ status: "refused" });
      challenge.dispose();
    })
  ));

it("never offers submission recovery for an ambiguous provider authorization", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const input = fixture({ confirm: () => Effect.succeed({ status: "uncertain" }) });
      const challenge = makeDaviplataChallenge(input);
      expect(yield* fromPromise(() => challenge.confirm(Redacted.make("574829")))).toEqual({
        status: "uncertain",
        retrySubmission: false,
      });
      expect(yield* fromPromise(() => challenge.retrySubmission())).toEqual({ status: "refused" });
      expect(input.submitApproved).not.toHaveBeenCalled();
      challenge.dispose();
    })
  ));

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

it("serializes pending OTP confirmation while leaving resend available afterwards", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const pending = yield* Deferred.make<DaviplataProviderOutcome>();
      const input = fixture({ confirm: vi.fn(() => Deferred.await(pending)) });
      const challenge = makeDaviplataChallenge(input);
      const firstOtp = Redacted.make("574829");
      const first = challenge.confirm(firstOtp);
      const duplicateOtp = Redacted.make("574829");
      expect(yield* fromPromise(() => challenge.confirm(duplicateOtp))).toEqual({
        status: "retry-allowed",
      });
      expect(() => Redacted.value(duplicateOtp)).toThrow();
      expect(yield* fromPromise(() => challenge.resend())).toEqual({ status: "retry-allowed" });
      yield* Deferred.succeed(pending, { status: "retry-allowed" });
      expect(yield* fromPromise(() => first)).toEqual({ status: "retry-allowed" });
      expect(() => Redacted.value(firstOtp)).toThrow();
      expect(yield* fromPromise(() => challenge.resend())).toEqual({ status: "retry-allowed" });
      expect(input.submitApproved).not.toHaveBeenCalled();
      challenge.dispose();
    })
  ));

it("projects pending approved submission as uncertain without replaying OTP or resubmitting", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const pending = yield* Deferred.make<PaymentSubmissionType>();
      const started = yield* Deferred.make<void>();
      const input = fixture();
      const context = yield* Effect.context<never>();
      input.submitApproved.mockImplementation(() =>
        Effect.runPromiseWith(context)(
          Effect.gen(function* () {
            yield* Deferred.succeed(started, undefined);
            return yield* Deferred.await(pending);
          })
        )
      );
      const challenge = makeDaviplataChallenge(input);
      const first = challenge.confirm(Redacted.make("574829"));
      yield* Deferred.await(started);
      expect(yield* fromPromise(() => challenge.retrySubmission())).toEqual({
        status: "uncertain",
        retrySubmission: true,
      });
      expect(yield* fromPromise(() => challenge.confirm(Redacted.make("574829")))).toEqual({
        status: "refused",
      });
      expect(yield* fromPromise(() => challenge.resend())).toEqual({ status: "refused" });
      expect(input.submitApproved).toHaveBeenCalledTimes(1);
      expect(input.provider.confirm).toHaveBeenCalledTimes(1);
      yield* Deferred.succeed(pending, submission);
      expect(yield* fromPromise(() => first)).toEqual({ status: "submitted", submission });
      expect(yield* fromPromise(() => challenge.retrySubmission())).toEqual({ status: "refused" });
      expect(input.provider.dispose).toHaveBeenCalledOnce();
    })
  ));

it.each(["refused", "execution-failure"] as const)(
  "disables recovery when provider approval is no longer usable after submission failure: %s",
  (failure) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const input = fixture({
          retrySubmission: () =>
            failure === "refused"
              ? Effect.succeed({ status: "refused" })
              : Effect.die(new Error("Synthetic authority failure")),
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
    )
);

it.each(["mounted", "authentication"] as const)(
  "refuses actions and consumes OTPs after cancellation of the %s lifetime",
  (lifetime) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const input = fixture();
        const challenge = makeDaviplataChallenge(input);
        if (lifetime === "mounted") challenge.dispose();
        else yield* fromPromise(() => input.client.dispose());
        const otp = Redacted.make("574829");
        expect(yield* fromPromise(() => challenge.confirm(otp))).toEqual({ status: "refused" });
        expect(() => Redacted.value(otp)).toThrow();
        expect(yield* fromPromise(() => challenge.resend())).toEqual({ status: "refused" });
        expect(input.submitApproved).not.toHaveBeenCalled();
        challenge.dispose();
      })
    )
);
