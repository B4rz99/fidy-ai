import { expect, it } from "@effect/vitest";
import { DateTime, Schema } from "effect";
import { BillingEmail, PriceId } from "~/core/subscription/contract";
import {
  EnrollmentPreparationDecision,
  EnrollmentSubmissionDecision,
  decideEnrollmentPreparation,
  decideEnrollmentSubmission,
} from "~/core/subscription/operations";

const weekly = PriceId.make("22700000-0000-4000-8000-000000000001");

const monthly = PriceId.make("22700000-0000-4000-8000-000000000002");

const now = DateTime.makeUnsafe("2026-04-01T12:00:00Z");

const later = DateTime.makeUnsafe("2026-04-01T12:15:00Z");

it("reuses canonical email normalization for billing", () => {
  expect(Schema.decodeSync(BillingEmail)(" PAYER@Example.COM ")).toBe("payer@example.com");
});

it("begins only a live prepared enrollment", () => {
  expect(
    decideEnrollmentSubmission({ status: "prepared", priceId: weekly, expiresAt: later }, now)
  ).toEqual(EnrollmentSubmissionDecision.BeginSubmission());
  expect(
    decideEnrollmentSubmission({ status: "prepared", priceId: weekly, expiresAt: now }, now)
  ).toEqual(EnrollmentSubmissionDecision.RecordExpiration());
});

it("returns the current status when provider work must not be replayed", () => {
  expect(decideEnrollmentSubmission({ status: "creating", priceId: weekly }, now)).toEqual(
    EnrollmentSubmissionDecision.ReturnCurrentStatus()
  );
  expect(decideEnrollmentSubmission({ status: "verifying", priceId: weekly }, now)).toEqual(
    EnrollmentSubmissionDecision.ReturnCurrentStatus()
  );
  expect(decideEnrollmentSubmission({ status: "available", priceId: weekly }, now)).toEqual(
    EnrollmentSubmissionDecision.ReturnCurrentStatus()
  );
});

it("replaces an unsubmitted intent when the User changes Price", () => {
  expect(decideEnrollmentPreparation({ status: "prepared", priceId: weekly }, monthly)).toEqual(
    EnrollmentPreparationDecision.ReplaceIntent()
  );
});

it("requires fresh terms but reuses an available source after a Price change", () => {
  expect(decideEnrollmentPreparation({ status: "available", priceId: weekly }, monthly)).toEqual(
    EnrollmentPreparationDecision.ReauthorizeSource()
  );
  expect(decideEnrollmentPreparation({ status: "available", priceId: weekly }, weekly)).toEqual(
    EnrollmentPreparationDecision.Observe()
  );
});

it("observes the same prepared Price and unresolved provider work", () => {
  expect(decideEnrollmentPreparation({ status: "prepared", priceId: weekly }, weekly)).toEqual(
    EnrollmentPreparationDecision.Observe()
  );

  for (const status of ["creating", "verifying"] as const) {
    expect(decideEnrollmentPreparation({ status, priceId: weekly }, monthly)).toEqual(
      EnrollmentPreparationDecision.Observe()
    );
  }
});

it("restarts after terminal enrollment outcomes", () => {
  for (const status of ["refused", "expired"] as const) {
    for (const priceId of [weekly, monthly]) {
      expect(decideEnrollmentPreparation({ status, priceId: weekly }, priceId)).toEqual(
        EnrollmentPreparationDecision.RestartRequired()
      );
    }

    expect(decideEnrollmentSubmission({ status, priceId: weekly }, now)).toEqual(
      EnrollmentSubmissionDecision.ReturnCurrentStatus()
    );
  }
});
