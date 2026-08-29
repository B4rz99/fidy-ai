import { expect, it } from "@effect/vitest";
import { DateTime, Schema } from "effect";
import { BillingEmail } from "./enrollment-model";
import { decideEnrollmentPreparation, decideEnrollmentSubmission } from "./enrollment-rules";
import { PriceId } from "./reference";

const weekly = PriceId.make("22700000-0000-4000-8000-000000000001");
const monthly = PriceId.make("22700000-0000-4000-8000-000000000002");
const now = DateTime.makeUnsafe("2026-04-01T12:00:00Z");
const later = DateTime.makeUnsafe("2026-04-01T12:15:00Z");

it("reuses canonical email normalization for billing", () => {
  expect(Schema.decodeUnknownSync(BillingEmail)(" PAYER@Example.COM ")).toBe("payer@example.com");
});

it("begins only a live prepared enrollment", () => {
  expect(
    decideEnrollmentSubmission({ status: "prepared", priceId: weekly, expiresAt: later }, now)
  ).toEqual({ _tag: "BeginSubmission" });
  expect(
    decideEnrollmentSubmission({ status: "prepared", priceId: weekly, expiresAt: now }, now)
  ).toEqual({ _tag: "RecordExpiration" });
});

it("returns the current status when provider work must not be replayed", () => {
  expect(decideEnrollmentSubmission({ status: "creating", priceId: weekly }, now)).toEqual({
    _tag: "ReturnCurrentStatus",
  });
  expect(decideEnrollmentSubmission({ status: "verifying", priceId: weekly }, now)).toEqual({
    _tag: "ReturnCurrentStatus",
  });
  expect(decideEnrollmentSubmission({ status: "available", priceId: weekly }, now)).toEqual({
    _tag: "ReturnCurrentStatus",
  });
});

it("replaces an unsubmitted intent when the User changes Price", () => {
  expect(decideEnrollmentPreparation({ status: "prepared", priceId: weekly }, monthly)).toEqual({
    _tag: "ReplaceIntent",
  });
});

it("requires fresh terms but reuses an available source after a Price change", () => {
  expect(decideEnrollmentPreparation({ status: "available", priceId: weekly }, monthly)).toEqual({
    _tag: "ReauthorizeSource",
  });
  expect(decideEnrollmentPreparation({ status: "available", priceId: weekly }, weekly)).toEqual({
    _tag: "Observe",
  });
});

it("observes the same prepared Price and unresolved provider work", () => {
  expect(decideEnrollmentPreparation({ status: "prepared", priceId: weekly }, weekly)).toEqual({
    _tag: "Observe",
  });
  for (const status of ["creating", "verifying"] as const) {
    expect(decideEnrollmentPreparation({ status, priceId: weekly }, monthly)).toEqual({
      _tag: "Observe",
    });
  }
});

it("restarts after terminal enrollment outcomes", () => {
  for (const status of ["refused", "expired"] as const) {
    for (const priceId of [weekly, monthly]) {
      expect(decideEnrollmentPreparation({ status, priceId: weekly }, priceId)).toEqual({
        _tag: "RestartRequired",
      });
    }
    expect(decideEnrollmentSubmission({ status, priceId: weekly }, now)).toEqual({
      _tag: "ReturnCurrentStatus",
    });
  }
});
