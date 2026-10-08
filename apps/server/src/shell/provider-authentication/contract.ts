import { Schema } from "effect";
import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from "effect/http-api";
import { BrowserLoginPairingId, BrowserLoginPrivateVerifier } from "~/core/browser-login/contract";
import { BackupRecoveryCode } from "~/core/recovery/contract";

const maximumRevisionLength = 128;
const invalidStatus = 400;
const unavailableStatus = 503;
export const providerPaths = {
  disclosure: "/web/providers/disclosure",
  start: "/web/providers/google/start",
  callback: "/providers/google/callback",
  status: "/web/providers/google/status",
  complete: "/web/providers/google/complete",
} as const;
export const microsoftProviderPaths = {
  start: "/web/providers/microsoft/start",
  callback: "/providers/microsoft/callback",
  status: "/web/providers/microsoft/status",
  complete: "/web/providers/microsoft/complete",
} as const;
export type AuthenticationProvider = "google" | "microsoft";
export const ProviderBrowserProof = Schema.Struct({
  pairingId: BrowserLoginPairingId,
  privateVerifier: BrowserLoginPrivateVerifier,
});
export const StartProviderAuthentication = Schema.Struct({
  ...ProviderBrowserProof.fields,
  intent: Schema.Literals(["signup", "login"]),
  consentRevision: Schema.String.check(Schema.isMaxLength(maximumRevisionLength)),
});
export const ProviderCompletion = Schema.Union([
  Schema.Struct({
    status: Schema.Literal("created"),
    backupRecoveryCode: Schema.RedactedFromValue(BackupRecoveryCode),
  }),
  Schema.Struct({ status: Schema.Literal("approved") }),
]);
export const WebSignupDisclosure = Schema.Struct({ revision: Schema.String, text: Schema.String });
const Refusal = Schema.Struct({ status: Schema.Literals(["invalid", "unavailable"]) });
export const ProviderAuthenticationGroup = HttpApiGroup.make("providerAuthentication")
  .add(
    HttpApiEndpoint.get("disclosure", providerPaths.disclosure, {
      success: WebSignupDisclosure,
      error: HttpApiSchema.status(unavailableStatus)(Refusal),
    })
  )
  .add(
    HttpApiEndpoint.post("start", providerPaths.start, {
      payload: StartProviderAuthentication,
      success: Schema.Struct({ authorizationUrl: Schema.String }),
      error: [
        HttpApiSchema.status(invalidStatus)(Refusal),
        HttpApiSchema.status(unavailableStatus)(Refusal),
      ],
    })
  )
  .add(
    HttpApiEndpoint.post("status", providerPaths.status, {
      payload: ProviderBrowserProof,
      success: Schema.Struct({ status: Schema.Literals(["pending", "verified", "rejected"]) }),
      error: HttpApiSchema.status(invalidStatus)(Refusal),
    })
  )
  .add(
    HttpApiEndpoint.post("complete", providerPaths.complete, {
      payload: ProviderBrowserProof,
      success: ProviderCompletion,
      error: [
        HttpApiSchema.status(invalidStatus)(Refusal),
        HttpApiSchema.status(unavailableStatus)(Refusal),
      ],
    })
  )
  .add(
    HttpApiEndpoint.post("startMicrosoft", microsoftProviderPaths.start, {
      payload: StartProviderAuthentication,
      success: Schema.Struct({ authorizationUrl: Schema.String }),
      error: [
        HttpApiSchema.status(invalidStatus)(Refusal),
        HttpApiSchema.status(unavailableStatus)(Refusal),
      ],
    })
  )
  .add(
    HttpApiEndpoint.post("statusMicrosoft", microsoftProviderPaths.status, {
      payload: ProviderBrowserProof,
      success: Schema.Struct({ status: Schema.Literals(["pending", "verified", "rejected"]) }),
      error: HttpApiSchema.status(invalidStatus)(Refusal),
    })
  )
  .add(
    HttpApiEndpoint.post("completeMicrosoft", microsoftProviderPaths.complete, {
      payload: ProviderBrowserProof,
      success: ProviderCompletion,
      error: [
        HttpApiSchema.status(invalidStatus)(Refusal),
        HttpApiSchema.status(unavailableStatus)(Refusal),
      ],
    })
  );
