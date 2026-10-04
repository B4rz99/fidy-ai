import { describe, expect, it } from "vitest";
import {
  decideOAuthCredentialExpirations,
  isReviewedOAuthExpiration,
  oauthAuthorizationCodeExpiresAt,
} from "./operations";

const current = 1_000_000_000;
const dayMs = 86_400_000;
describe("reviewed OAuth expiration", () => {
  it.each([
    {
      label: "exact reviewed lifetime",
      reviewedAt: current,
      expiresAt: current + 7 * dayMs,
      accepted: true,
    },
    {
      label: "future review",
      reviewedAt: current + 1,
      expiresAt: current + 1 + 7 * dayMs,
      accepted: false,
    },
    {
      label: "last live review instant",
      reviewedAt: current - 599_999,
      expiresAt: current - 599_999 + 7 * dayMs,
      accepted: true,
    },
    {
      label: "expired review boundary",
      reviewedAt: current - 600_000,
      expiresAt: current - 600_000 + 7 * dayMs,
      accepted: false,
    },
    {
      label: "extended reviewed expiration",
      reviewedAt: current,
      expiresAt: current + 7 * dayMs + 1,
      accepted: false,
    },
    {
      label: "changed reviewed expiration",
      reviewedAt: current,
      expiresAt: current + 7 * dayMs - 1,
      accepted: false,
    },
  ] as const)("$label", ({ reviewedAt, expiresAt, accepted }) => {
    expect(isReviewedOAuthExpiration({ current, reviewedAt, expiresAt, lifetimeDays: 7 })).toBe(
      accepted
    );
  });
});
describe("finite OAuth issuance", () => {
  it("gives authorization codes only one minute", () => {
    expect(oauthAuthorizationCodeExpiresAt(current)).toBe(1_000_060_000);
  });
  it.each([
    {
      grantExpiresAt: 1_000_000_001,
      expected: { accessExpiresAt: 1_000_000_001, refreshExpiresAt: 1_000_000_001 },
    },
    {
      grantExpiresAt: 1_000_600_000,
      expected: { accessExpiresAt: 1_000_600_000, refreshExpiresAt: 1_000_600_000 },
    },
    {
      grantExpiresAt: 3_592_000_000,
      expected: { accessExpiresAt: 1_000_600_000, refreshExpiresAt: 3_592_000_000 },
    },
    {
      grantExpiresAt: 32_536_000_000,
      expected: { accessExpiresAt: 1_000_600_000, refreshExpiresAt: 3_592_000_000 },
    },
  ] as const)(
    "caps credentials for the worked grant expiration $grantExpiresAt",
    ({ grantExpiresAt, expected }) => {
      expect(decideOAuthCredentialExpirations({ current, grantExpiresAt })).toEqual(expected);
    }
  );
});
