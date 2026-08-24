import { HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi";
import { CreateManualPATPayload, IssuedManualPAT } from "~/core/tokens/model";
import { freshWebSessionOnly, operationPolicy } from "~/shell/_shared/operation-policy";
import { OperationResponse } from "~/shell/_shared/response";
import { ManualPATIssuanceConsumed, ManualPATIssuanceRateLimited } from "./errors";

const createManualPAT = HttpApiEndpoint.post("createManualPAT", "/pats", {
  payload: CreateManualPATPayload,
  success: OperationResponse(IssuedManualPAT),
  error: [ManualPATIssuanceConsumed, ManualPATIssuanceRateLimited],
})
  .annotate(
    OpenApi.Description,
    "Create one PAT after first-party browser review. The response discloses the raw bearer once; retain it securely because Fidy persists only its digest."
  )
  .annotateMerge(
    operationPolicy({
      access: freshWebSessionOnly,
      requiredTier: "free",
      agentConfirmation: "not-required",
      kind: "mutation",
    })
  );

/** Fresh authenticated-web operations that create and disclose PAT authority. */
export const PATsGroup = HttpApiGroup.make("pats").add(createManualPAT);
