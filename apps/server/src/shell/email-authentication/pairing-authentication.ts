import {
  type BrowserPairingEmailBackgroundStepOutcome,
  processNextBackgroundStep,
} from "./authentication-delivery-worker";
import {
  requestBrowserPairingEmailCode,
  submitBrowserPairingEmailCode,
} from "./browser-pairing-authentication";

/**
 * Deep verified-email BrowserLogin approval interface. Request and resend share `requestCode`;
 * `submitCode` may only approve the existing pairing; the background entry point hides request,
 * delivery, claim, lock, and provider-settlement identities from its worker caller.
 */
export const browserPairingEmailAuthentication = {
  requestCode: requestBrowserPairingEmailCode,
  submitCode: submitBrowserPairingEmailCode,
  processNextBackgroundStep,
} as const;

export type { BrowserPairingEmailBackgroundStepOutcome };
