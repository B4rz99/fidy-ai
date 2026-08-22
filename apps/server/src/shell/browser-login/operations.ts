import { Schema } from "effect";
import { HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi";
import { CanonicalOperationId } from "~/core/_shared/canonical-operation";
import { UtcTimestamp } from "~/core/_shared/time";
import { BrowserLoginPairingId } from "~/core/browser-login/reference";
import { hostedWhatsAppOperationPolicy } from "~/shell/_shared/operation-policy";
import { OperationResponse } from "~/shell/_shared/response";
import {
  BrowserLoginPairingApprovalRateLimited,
  BrowserLoginPairingApprovalRejected,
} from "./approval-errors";

/** Stable canonical identity of hosted browser-pairing approval. */
export const browserLoginApprovalOperation = CanonicalOperationId.make(
  "browserLogin.approvePairing"
);

/** Deliberately accepts text broadly so malformed submissions share the bounded generic refusal. */
export const ApproveBrowserLoginPairingPayload = Schema.Struct({
  publicCode: Schema.String,
}).annotate({ identifier: "ApproveBrowserLoginPairingPayload" });

export const BrowserLoginPairingApproval = Schema.Struct({
  pairingId: BrowserLoginPairingId,
  expiresAt: UtcTimestamp,
}).annotate({ identifier: "BrowserLoginPairingApproval" });

export const BrowserLoginGroup = HttpApiGroup.make("browserLogin").add(
  HttpApiEndpoint.post("approvePairing", "/browser-login/pairings/approve", {
    payload: ApproveBrowserLoginPairingPayload,
    success: OperationResponse(BrowserLoginPairingApproval),
    error: [BrowserLoginPairingApprovalRejected, BrowserLoginPairingApprovalRateLimited],
  })
    .annotate(
      OpenApi.Description,
      "Approve the displayed browser pairing code for this User. The host requires exact explicit " +
        "confirmation before execution; the code is public and is never a browser credential."
    )
    .annotateMerge(
      hostedWhatsAppOperationPolicy({
        requiredCapability: "write",
        requiredTier: "free",
        agentConfirmation: "required",
        kind: "mutation",
      })
    )
);
