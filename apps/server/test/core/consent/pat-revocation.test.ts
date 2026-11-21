import { expect, it } from "@effect/vitest";
import { Schema } from "effect";
import {
  ApprovedUnclaimedExpiryPATRevocation,
  AuthenticatedWebPATRevocation,
  FixedLifetimeExpiryPATRevocation,
} from "~/core/consent/contract";
import { decidePATRevocation } from "~/core/consent/operations";

it("distinguishes a User's authenticated revocation from automatic PAT expiry", () => {
  const userRevocation = decidePATRevocation("user-revoke-one");

  expect(Schema.is(AuthenticatedWebPATRevocation)(userRevocation)).toBe(true);
  expect(userRevocation.revision).toBe("pat-revocation-2026-09");
  expect(
    Schema.is(ApprovedUnclaimedExpiryPATRevocation)(
      decidePATRevocation("approved-unclaimed-expiry")
    )
  ).toBe(true);
  expect(
    Schema.is(FixedLifetimeExpiryPATRevocation)(decidePATRevocation("fixed-lifetime-expiry"))
  ).toBe(true);
});
