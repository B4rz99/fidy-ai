import { HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi";
import { UpgradeDestination } from "~/core/subscription/model";
import { operationPolicy } from "~/shell/_shared/operation-policy";
import { OperationResponse } from "~/shell/_shared/response";

/** Canonical Free operation group for discovering the public-web upgrade destination. */
export const SubscriptionGroup = HttpApiGroup.make("subscription").add(
  HttpApiEndpoint.get("getUpgradeUrl", "/subscription/upgrade-url", {
    success: OperationResponse(UpgradeDestination),
  })
    .annotate(
      OpenApi.Description,
      "Get the public web destination for starting Pro access. Use it after a Paywall or Free " +
        "allowance response when the User asks how to upgrade."
    )
    .annotateMerge(
      operationPolicy({
        requiredScope: "read",
        requiredTier: "free",
        costClass: "cheap",
        agentConfirmation: "not-required",
        kind: "query",
      })
    )
);
