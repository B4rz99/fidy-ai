import { expect, it } from "@effect/vitest";
import { DateTime, Redacted, Result, Schema } from "effect";
import {
  EmailAddress,
  EmailVerificationCode,
  EmailVerificationProof,
  EmailVerificationPublicCode,
  PendingEmailEnrollment,
  VerifiedEmailCredential,
  VerifiedEmailCredentialLifecycleEvent,
  VerifiedEmailCredentialLifecycleEventId,
} from "./model";
import { PendingConsentExchangeId } from "~/core/consent/reference";
import {
  UserId,
  WhatsAppBusinessPortfolioId,
  WhatsAppBusinessScopedUserId,
} from "~/core/identity/reference";
import { WebSessionId } from "~/core/web-session/reference";
import { EmailEnrollmentId } from "./reference";

const decodeEmail = Schema.decodeUnknownResult(EmailAddress);

it("trims and lowercases a conservative mailbox without provider alias folding", () => {
  expect(decodeEmail("  Person.Name+Fidy@Example.COM  ")).toEqual(
    Result.succeed(EmailAddress.make("person.name+fidy@example.com"))
  );
  expect(decodeEmail("person.name@example.com")).not.toEqual(decodeEmail("personname@example.com"));
});

it("rejects mailbox forms outside the bounded launch grammar", () => {
  const rejected = [
    "a@localhost",
    ".a@example.com",
    "a.@example.com",
    "a..b@example.com",
    '"a b"@example.com',
    "a@[127.0.0.1]",
    `a@${"x".repeat(64)}.com`,
    `${"a".repeat(251)}@x.co`,
  ];
  for (const candidate of rejected) expect(Result.isFailure(decodeEmail(candidate))).toBe(true);
});

it("models the public lookup separately from the redacted verification proof", () => {
  expect(EmailVerificationPublicCode.make("ABCD-2345")).toBe("ABCD-2345");
  expect(EmailVerificationProof.make("F7KM-9Q2D-X4PT-6RWC")).toBe("F7KM-9Q2D-X4PT-6RWC");
  expect(EmailVerificationCode.make("ABCD-2345-F7KM-9Q2D-X4PT-6RWC")).toBe(
    "ABCD-2345-F7KM-9Q2D-X4PT-6RWC"
  );
});

it("rejects out-of-range delivery generations and non-SHA-256 proof digests", () => {
  const enrollment = {
    _tag: "AwaitingProof" as const,
    id: EmailEnrollmentId.make("f1d1a000-0000-4000-8000-000000000902"),
    publicCode: EmailVerificationPublicCode.make("ABCD-2345"),
    caller: {
      businessPortfolioId: WhatsAppBusinessPortfolioId.make("portfolio-test"),
      businessScopedUserId: WhatsAppBusinessScopedUserId.make("CO.test"),
    },
    consent: {
      pendingConsentExchangeId: PendingConsentExchangeId.make(
        "f1d1a000-0000-4000-8000-000000000903"
      ),
    },
    expiresAt: DateTime.makeUnsafe("2026-08-24T12:00:00Z"),
    email: EmailAddress.make("user@example.com"),
    deliveryGeneration: 5,
    resendAvailableAt: DateTime.makeUnsafe("2026-08-23T12:01:00Z"),
    wrongProofAttempts: 0,
    proofDigest: new Uint8Array(32),
    proofExpiresAt: DateTime.makeUnsafe("2026-08-23T12:10:00Z"),
  };
  expect(PendingEmailEnrollment.make(enrollment)).toEqual(enrollment);
  expect(() => PendingEmailEnrollment.make({ ...enrollment, deliveryGeneration: 0 })).toThrow();
  expect(() => PendingEmailEnrollment.make({ ...enrollment, deliveryGeneration: 6 })).toThrow();
  expect(() =>
    PendingEmailEnrollment.make({ ...enrollment, proofDigest: new Uint8Array(31) })
  ).toThrow();
});

it("keeps VerifiedEmailCredential separate from User identity and session authority", () => {
  const credential = VerifiedEmailCredential.make({
    userId: UserId.make("f1d1a000-0000-4000-8000-000000000901"),
    email: EmailAddress.make("user@example.com"),
    verifiedAt: DateTime.makeUnsafe("2026-08-23T12:00:00Z"),
  });
  expect(credential).toEqual({
    userId: "f1d1a000-0000-4000-8000-000000000901",
    email: "user@example.com",
    verifiedAt: DateTime.makeUnsafe("2026-08-23T12:00:00Z"),
  });
  expect(credential).not.toHaveProperty("sessionBearer");
  expect(Redacted.isRedacted(credential.email)).toBe(false);
});

it("models committed replacement evidence with exactly stable metadata", () => {
  const event = VerifiedEmailCredentialLifecycleEvent.make({
    id: VerifiedEmailCredentialLifecycleEventId.make("f1d1a000-0000-4000-8000-000000000904"),
    subjectUserId: UserId.make("f1d1a000-0000-4000-8000-000000000901"),
    authorizingWebSessionId: WebSessionId.make("f1d1a000-0000-4000-8000-000000000905"),
    kind: "Replaced",
    occurredAt: DateTime.makeUnsafe("2026-08-23T12:30:00Z"),
  });

  expect(Object.keys(event)).toEqual([
    "id",
    "subjectUserId",
    "authorizingWebSessionId",
    "kind",
    "occurredAt",
  ]);
  expect(event).not.toHaveProperty("email");
  expect(event).not.toHaveProperty("workflowId");
  expect(event).not.toHaveProperty("proofDigest");
});
