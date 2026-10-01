import type { PATRevocationDisclosure, PATRevocationOrigin } from "~/core/consent/contract";

const revision = "pat-revocation-2026-09";
/** Fixed historical disclosure and attribution for each terminal PAT policy. */
export const disclosures = {
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
