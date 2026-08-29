import { expect, it } from "@effect/vitest";
import { Schema } from "effect";
import { EmailNeedsReviewItem, RawEmailIngestSample } from "./model";

const rawSample = {
  id: "f1d1a000-0000-4000-8000-000000000201",
  receivedEmailId: "received-email-1",
  serviceMarket: "CO",
  locale: "es-CO",
  timeZone: "America/Bogota",
  sourceFormat: "notification-email",
  sourceProvider: "resend",
  parserRevision: "notification-email-parser-v1",
  content: {
    receivedEmailId: "received-email-1",
    from: "alerts@example.test",
    to: ["test@ingest.fidyapp.com"],
    subject: "Compra",
    inlineImages: [],
    createdAt: "2026-08-28T12:00:00Z",
  },
  retainedAt: "2026-08-28T12:00:00Z",
  expiresAt: "2026-08-28T12:00:01Z",
} as const;

it("rejects a Raw Email IngestSample whose expiry is not after retention", () => {
  expect(
    Schema.decodeUnknownResult(RawEmailIngestSample)({
      ...rawSample,
      expiresAt: rawSample.retainedAt,
    })._tag
  ).toBe("Failure");
});

const reviewBase = {
  id: "f1d1a000-0000-4000-8000-000000000202",
  receivedEmailId: "received-email-1",
  serviceMarket: "CO",
  locale: "es-CO",
  timeZone: "America/Bogota",
  sourceFormat: "notification-email",
  sourceChannel: "forwarded-email",
  sourceProvider: "resend",
  messageEvidence: {
    channel: "email",
    provider: "resend",
    providerMessageId: "received-email-1",
  },
  parserRevision: "notification-email-parser-v1",
  extractorRevision: "notification-email-extractor-v1",
  issues: [],
  createdAt: "2026-08-28T12:00:00Z",
  status: "pending",
} as const;

it("requires raw evidence for model and canonical review reasons", () => {
  expect(
    Schema.decodeUnknownResult(EmailNeedsReviewItem)({
      ...reviewBase,
      reason: "model-unavailable",
    })._tag
  ).toBe("Failure");
  expect(
    Schema.decodeUnknownResult(EmailNeedsReviewItem)({
      ...reviewBase,
      reason: "provider-retrieval-failed",
    })._tag
  ).toBe("Success");
});
