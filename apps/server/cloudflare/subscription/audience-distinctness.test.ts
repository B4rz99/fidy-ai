import { describe, expect, it } from "vitest";
import type { PricingEnvironment, RefundSupportEnvironment } from "./contract";
import { validSupportConfiguration } from "./internal/refund-support";
import { pricingPeerAudiences } from "./internal/publish-price";

const refundEnvironment = {
  WOMPI_ENVIRONMENT: "sandbox",
  CLOUDFLARE_ACCESS_ISSUER: "https://fidy.cloudflareaccess.com",
  CLOUDFLARE_ACCESS_AUDIENCE: "access",
  BETA_PRO_AUDIENCE: "beta",
  BILLING_SUPPORT_AUDIENCE: "billing",
  ERASURE_SUPPORT_AUDIENCE: "erasure",
  PRICING_PUBLISH_AUDIENCE: "pricing",
  SAMPLE_REVIEW_AUDIENCE: "sample",
} as const satisfies RefundSupportEnvironment;

const pricingEnvironment = {
  CLOUDFLARE_ACCESS_ISSUER: "https://fidy.cloudflareaccess.com",
  CLOUDFLARE_ACCESS_AUDIENCE: "access",
  BETA_PRO_AUDIENCE: "beta",
  BILLING_SUPPORT_AUDIENCE: "billing",
  ERASURE_SUPPORT_AUDIENCE: "erasure",
  PRICING_PUBLISH_AUDIENCE: "pricing",
  SAMPLE_REVIEW_AUDIENCE: "sample",
} as const satisfies PricingEnvironment;

describe("operator audience distinctness", () => {
  it("accepts a billing audience distinct from every peer", () => {
    expect(validSupportConfiguration(refundEnvironment)).toBe(true);
  });

  it.each([
    "BETA_PRO_AUDIENCE",
    "CLOUDFLARE_ACCESS_AUDIENCE",
    "ERASURE_SUPPORT_AUDIENCE",
    "PRICING_PUBLISH_AUDIENCE",
    "SAMPLE_REVIEW_AUDIENCE",
  ] as const)("rejects a billing audience shared with %s", (peer) => {
    expect(
      validSupportConfiguration({
        ...refundEnvironment,
        [peer]: refundEnvironment.BILLING_SUPPORT_AUDIENCE,
      })
    ).toBe(false);
  });

  it("lists the sample-review audience as a pricing peer", () => {
    expect(pricingPeerAudiences(pricingEnvironment)).toContain("sample");
  });
});
