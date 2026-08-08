import { expect, it } from "@effect/vitest";
import {
  UserId,
  WhatsAppBusinessPortfolioId,
  WhatsAppBusinessScopedUserId,
  whatsAppCallerReference,
} from "~/core/identity/reference";
import { advisoryLockKey } from "./advisory-lock";

const userId = UserId.make("f1d1a000-0000-4000-8000-000000000a30");

it("keeps unrelated slice locks distinct for the same User", () => {
  const keys = [
    advisoryLockKey.keywordRules(userId),
    advisoryLockKey.dashboard(userId),
    advisoryLockKey.consentSubject(userId),
    advisoryLockKey.whatsAppAdmission(userId),
  ].map(({ value, seed }) => `${seed}:${value}`);

  expect(new Set(keys).size).toBe(keys.length);
});

it("shares the bare User key only between WhatsApp admission and database claims", () => {
  expect(advisoryLockKey.whatsAppAdmission(userId)).toEqual({ value: userId, seed: 0 });
});

it("namespaces pre-subject Consent locks by both WhatsApp identity coordinates", () => {
  const caller = whatsAppCallerReference({
    businessPortfolioId: WhatsAppBusinessPortfolioId.make("portfolio-lock-test"),
    businessScopedUserId: WhatsAppBusinessScopedUserId.make("CO.LockTest"),
  });

  expect(advisoryLockKey.consentGate(caller)).toEqual({
    value: "consent-gate:portfolio-lock-test:CO.LockTest",
    seed: 0,
  });
});
