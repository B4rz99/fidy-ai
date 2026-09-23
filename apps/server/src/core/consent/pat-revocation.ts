import { Schema } from "effect";

/** Closed origins for symmetric PAT Consent revocations; only expiry is automatic. */
export const PATRevocationOrigin = Schema.Literals([
  "user-revoke-one",
  "user-revoke-all",
  "user-revoke-unclaimed",
  "approved-unclaimed-expiry",
  "fixed-lifetime-expiry",
]);
export type PATRevocationOrigin = typeof PATRevocationOrigin.Type;

type PATRevocationDisclosure = Readonly<{ revision: string; text: string }> &
  (
    | Readonly<{ _tag: "AuthenticatedWeb" }>
    | Readonly<{
        _tag: "AutomaticPolicy";
        policyReason: "pat-approved-unclaimed-expiry" | "pat-fixed-lifetime-expiry";
      }>
  );
const revision = "pat-revocation-2026-09";
const disclosures = {
  "user-revoke-one": { _tag: "AuthenticatedWeb", revision, text: "User revoked this PAT." },
  "user-revoke-all": { _tag: "AuthenticatedWeb", revision, text: "User revoked all active PATs." },
  "user-revoke-unclaimed": {
    _tag: "AuthenticatedWeb",
    revision,
    text: "User revoked all unclaimed PAT approvals.",
  },
  "approved-unclaimed-expiry": {
    _tag: "AutomaticPolicy",
    revision,
    text: "Unclaimed PAT approval expired under the fixed claim deadline.",
    policyReason: "pat-approved-unclaimed-expiry",
  },
  "fixed-lifetime-expiry": {
    _tag: "AutomaticPolicy",
    revision,
    text: "PAT expired at the fixed lifetime deadline.",
    policyReason: "pat-fixed-lifetime-expiry",
  },
} as const satisfies Record<PATRevocationOrigin, PATRevocationDisclosure>;

/** Derives the fixed disclosure and attributable source for a PAT grant's terminal transition. */
export const decidePATRevocation = <Origin extends PATRevocationOrigin>(
  origin: Origin
): (typeof disclosures)[Origin] => disclosures[origin];
