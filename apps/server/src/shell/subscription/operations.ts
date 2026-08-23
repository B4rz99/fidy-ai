import { HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi";
import { SubscriptionOffers, UpgradeDestination } from "~/core/subscription/model";
import { operationPolicy } from "~/shell/_shared/operation-policy";
import { OperationResponse } from "~/shell/_shared/response";

const getUpgradeUrl = HttpApiEndpoint.get("getUpgradeUrl", "/subscription/upgrade-url", {
  success: OperationResponse(UpgradeDestination),
})
  .annotate(
    OpenApi.Description,
    "Get the public web destination for starting Pro access. Use it after a Paywall or Free " +
      "allowance response when the User asks how to upgrade."
  )
  .annotateMerge(
    operationPolicy({
      requiredCapability: "read",
      requiredTier: "free",
      agentConfirmation: "not-required",
      kind: "query",
    })
  );

const listSubscriptionOffers = HttpApiEndpoint.get(
  "listSubscriptionOffers",
  "/subscription/offers",
  { success: OperationResponse(SubscriptionOffers) }
)
  .annotate(
    OpenApi.Description,
    "List the authoritative immutable Colombia PriceRevisions and renewal terms available before " +
      "payment-method enrollment."
  )
  .annotateMerge(
    operationPolicy({
      requiredCapability: "read",
      requiredTier: "free",
      agentConfirmation: "not-required",
      kind: "query",
    })
  );

/** Canonical Free operation group for discovering and presenting Subscription upgrade offers. */
export const SubscriptionGroup = HttpApiGroup.make("subscription")
  .add(getUpgradeUrl)
  .add(listSubscriptionOffers);
