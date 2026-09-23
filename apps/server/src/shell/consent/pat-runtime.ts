/** Consent-owned decision projected to the Cloudflare transaction-aware D1 adapter. */
export { decidePATRevocation, PATRevocationOrigin } from "~/core/consent/pat-revocation";
export {
  revokeOnePATConsent,
  revokeAllPATConsents,
  revokeAllPairingConsents,
  expirePairingConsents,
  expirePATConsents,
  grantManualPATConsent,
  grantPairedPATConsent,
} from "./pat-evidence";
