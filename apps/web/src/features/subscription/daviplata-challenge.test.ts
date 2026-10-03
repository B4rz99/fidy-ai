import { Deferred, Effect, Redacted } from "effect";
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

const clients: Array<ReturnType<typeof makeSubscriptionEnrollmentClient>> = [];
afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.dispose()));
});
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

it("allows a new OTP after a retryable refusal without submitting provider authority", async () => {
  const input = fixture({ confirm: vi.fn(() => Effect.succeed({ status: "retry-allowed" })) });
  const challenge = makeDaviplataChallenge(input);
  const otp = Redacted.make("574829");
  expect(await challenge.confirm(otp)).toEqual({ status: "retry-allowed" });
  expect(() => Redacted.value(otp)).toThrow();
  expect(await challenge.resend()).toEqual({ status: "retry-allowed" });
  expect(input.submitApproved).not.toHaveBeenCalled();
  expect(await challenge.retrySubmission()).toEqual({ status: "refused" });
  challenge.dispose();
});

it("never offers submission recovery for an ambiguous provider authorization", async () => {
  const input = fixture({ confirm: () => Effect.succeed({ status: "uncertain" }) });
  const challenge = makeDaviplataChallenge(input);
  expect(await challenge.confirm(Redacted.make("574829"))).toEqual({
    status: "uncertain",
    retrySubmission: false,
  });
  expect(await challenge.retrySubmission()).toEqual({ status: "refused" });
  expect(input.submitApproved).not.toHaveBeenCalled();
  challenge.dispose();
});

it("contains provider execution failure and wipes the OTP without submitting", async () => {
  const input = fixture({ confirm: () => Effect.die(new Error("Synthetic provider failure")) });
  const challenge = makeDaviplataChallenge(input);
  const otp = Redacted.make("574829");
  expect(await challenge.confirm(otp)).toEqual({ status: "uncertain", retrySubmission: false });
  expect(() => Redacted.value(otp)).toThrow();
  expect(input.submitApproved).not.toHaveBeenCalled();
  challenge.dispose();
});

it("serializes pending OTP confirmation while leaving resend available afterwards", async () => {
  const pending = Deferred.makeUnsafe<DaviplataProviderOutcome>();
  const input = fixture({ confirm: vi.fn(() => Deferred.await(pending)) });
  const challenge = makeDaviplataChallenge(input);
  const firstOtp = Redacted.make("574829");
  const first = challenge.confirm(firstOtp);
  const duplicateOtp = Redacted.make("574829");
  expect(await challenge.confirm(duplicateOtp)).toEqual({ status: "retry-allowed" });
  expect(() => Redacted.value(duplicateOtp)).toThrow();
  expect(await challenge.resend()).toEqual({ status: "retry-allowed" });
  Effect.runSync(Deferred.succeed(pending, { status: "retry-allowed" }));
  expect(await first).toEqual({ status: "retry-allowed" });
  expect(() => Redacted.value(firstOtp)).toThrow();
  expect(await challenge.resend()).toEqual({ status: "retry-allowed" });
  expect(input.submitApproved).not.toHaveBeenCalled();
  challenge.dispose();
});

it("projects pending approved submission as uncertain without replaying OTP or resubmitting", async () => {
  let finish: (result: PaymentSubmissionType) => void = () => {};
  const pending = new Promise<PaymentSubmissionType>((resolve) => {
    finish = resolve;
  });
  const input = fixture();
  const started = Promise.withResolvers<void>();
  input.submitApproved.mockImplementation(() => {
    started.resolve();
    return pending;
  });
  const challenge = makeDaviplataChallenge(input);
  const first = challenge.confirm(Redacted.make("574829"));
  await started.promise;
  expect(await challenge.retrySubmission()).toEqual({ status: "uncertain", retrySubmission: true });
  expect(await challenge.confirm(Redacted.make("574829"))).toEqual({ status: "refused" });
  expect(await challenge.resend()).toEqual({ status: "refused" });
  expect(input.submitApproved).toHaveBeenCalledTimes(1);
  expect(input.provider.confirm).toHaveBeenCalledTimes(1);
  finish(submission);
  expect(await first).toEqual({ status: "submitted", submission });
  expect(await challenge.retrySubmission()).toEqual({ status: "refused" });
  expect(input.provider.dispose).toHaveBeenCalledOnce();
});

it.each(["refused", "execution-failure"] as const)(
  "disables recovery when provider approval is no longer usable after submission failure: %s",
  async (failure) => {
    const input = fixture({
      retrySubmission: () =>
        failure === "refused"
          ? Effect.succeed({ status: "refused" })
          : Effect.die(new Error("Synthetic authority failure")),
    });
    input.submitApproved.mockRejectedValue(new Error("Synthetic submission failure"));
    const challenge = makeDaviplataChallenge(input);
    expect(await challenge.confirm(Redacted.make("574829"))).toEqual({
      status: "uncertain",
      retrySubmission: false,
    });
    expect(input.submitApproved).toHaveBeenCalledTimes(1);
    expect(await challenge.resend()).toEqual({ status: "refused" });
    challenge.dispose();
  }
);

it.each(["mounted", "authentication"] as const)(
  "refuses actions and consumes OTPs after cancellation of the %s lifetime",
  async (lifetime) => {
    const input = fixture();
    const challenge = makeDaviplataChallenge(input);
    if (lifetime === "mounted") challenge.dispose();
    else await input.client.dispose();
    const otp = Redacted.make("574829");
    expect(await challenge.confirm(otp)).toEqual({ status: "refused" });
    expect(() => Redacted.value(otp)).toThrow();
    expect(await challenge.resend()).toEqual({ status: "refused" });
    expect(input.submitApproved).not.toHaveBeenCalled();
    challenge.dispose();
  }
);
