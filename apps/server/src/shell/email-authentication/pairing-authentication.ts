import { Data, Effect, type Redacted } from "effect";
import type { EmailAddress, EmailVerificationCode } from "~/core/email-authentication/model";
import type { BrowserLoginPrivateVerifier } from "~/core/browser-login/model";
import type { BrowserLoginPairingId } from "~/core/browser-login/reference";
import { BrowserLoginPairingInvalid } from "~/shell/browser-login/errors";

/** The removed process-local delivery authority never accepts a browser pairing request. */
export class BrowserPairingEmailAuthenticationUnavailable extends Data.TaggedError(
  "BrowserPairingEmailAuthenticationUnavailable"
)<{}> {}

/**
 * Browser authentication remains a contract-only seam until the Cloudflare Worker/Email Worker
 * adapter owns the pairing state and delivery. It must not fall back to the deleted SQL/workflow
 * implementation.
 */
const browserPairingRetryAfterSeconds = 60;

export const browserPairingEmailAuthentication: {
  readonly requestCode: (input: {
    readonly pairingId: BrowserLoginPairingId;
    readonly privateVerifier: BrowserLoginPrivateVerifier;
    readonly email: EmailAddress;
    readonly sourceAddress: string;
  }) => Effect.Effect<
    Readonly<{
      readonly status: "pending";
      readonly retryAfterSeconds: typeof browserPairingRetryAfterSeconds;
    }>,
    BrowserLoginPairingInvalid
  >;
  readonly submitCode: (input: {
    readonly pairingId: BrowserLoginPairingId;
    readonly privateVerifier: BrowserLoginPrivateVerifier;
    readonly combinedCode: Redacted.Redacted<EmailVerificationCode>;
    readonly sourceAddress: string;
  }) => Effect.Effect<boolean>;
} = {
  requestCode: (_input: {
    readonly pairingId: BrowserLoginPairingId;
    readonly privateVerifier: BrowserLoginPrivateVerifier;
    readonly email: EmailAddress;
    readonly sourceAddress: string;
  }): Effect.Effect<
    Readonly<{
      readonly status: "pending";
      readonly retryAfterSeconds: typeof browserPairingRetryAfterSeconds;
    }>,
    BrowserLoginPairingInvalid
  > => Effect.fail(new BrowserLoginPairingInvalid()),
  submitCode: (_input: {
    readonly pairingId: BrowserLoginPairingId;
    readonly privateVerifier: BrowserLoginPrivateVerifier;
    readonly combinedCode: Redacted.Redacted<EmailVerificationCode>;
    readonly sourceAddress: string;
  }) => Effect.succeed(false),
};
