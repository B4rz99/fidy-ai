import { Effect } from "effect";
import type { OAuthCaller } from "../../../src/shell/oauth-agents/contract";
import type { CatalogOperation } from "../../../src/shell/canonical-catalog/contract";
import type { CanonicalMutationRefusal } from "../contract";
import { recordOAuthRefusal } from "./oauth-response";
import { refusedCredentialResponse, transactionUnavailable } from "../../canonical-work/operations";

const confirmationRequiredStatus = 403;
const confirmationMessage = "Verified User confirmation is required for this operation.";

/** OAuth supplies no verified confirmation evidence in this slice; the canonical declaration decides sensitivity. */
export const requiresOAuthConfirmation = (operation: CatalogOperation): boolean =>
  operation.policy.agentConfirmation === "required";

export const oauthConfirmationRefusal = (
  input: Readonly<{
    db: D1Database;
    subject: OAuthCaller;
    current: number;
    operation: CatalogOperation;
  }>
): CanonicalMutationRefusal => ({
  code: "user_action_required",
  message: confirmationMessage,
  record: () => recordOAuthRefusal({ ...input, operation: input.operation.id }),
  respond: (disposition) => {
    if (disposition === "credential_refused") return refusedCredentialResponse(input);
    if (disposition !== "recorded") return Effect.succeed(transactionUnavailable());
    return Effect.succeed(
      Response.json(
        { error: { code: "user_action_required", message: confirmationMessage }, next: [] },
        { status: confirmationRequiredStatus, headers: { "cache-control": "no-store" } }
      )
    );
  },
});
