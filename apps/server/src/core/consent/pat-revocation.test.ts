import { expect, it } from "@effect/vitest";
import { decidePATRevocation } from "./pat-revocation";

it("distinguishes a User's authenticated revocation from automatic PAT expiry", () => {
  expect(decidePATRevocation("user-revoke-one")).toMatchObject({
    _tag: "AuthenticatedWeb",
    revision: "pat-revocation-2026-09",
  });
  expect(decidePATRevocation("approved-unclaimed-expiry")).toMatchObject({
    _tag: "AutomaticPolicy",
    policyReason: "pat-approved-unclaimed-expiry",
  });
  expect(decidePATRevocation("fixed-lifetime-expiry")).toMatchObject({
    _tag: "AutomaticPolicy",
    policyReason: "pat-fixed-lifetime-expiry",
  });
});
