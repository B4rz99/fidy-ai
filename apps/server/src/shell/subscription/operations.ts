import { HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi";
import {
  SubscriptionOffers,
  SubscriptionStatus,
  UpgradeDestination,
} from "~/core/subscription/model";
import { operationPolicy, patScoped } from "~/shell/_shared/operation-policy";
import { OperationResponse, Unavailable } from "~/shell/public-http/contract";

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
      access: patScoped("read"),
      requiredTier: "free",
      agentConfirmation: "not-required",
      kind: "query",
    })
  );

const listSubscriptionOffers = HttpApiEndpoint.get(
  "listSubscriptionOffers",
  "/subscription/offers",
  { success: OperationResponse(SubscriptionOffers), error: Unavailable }
)
  .annotate(
    OpenApi.Description,
    "List the authoritative immutable Colombia Prices and renewal terms available before " +
      "payment-method enrollment."
  )
  .annotateMerge(
    operationPolicy({
      access: patScoped("read"),
      requiredTier: "free",
      agentConfirmation: "not-required",
      kind: "query",
    })
  );

const getSubscriptionStatus = HttpApiEndpoint.get("getSubscriptionStatus", "/subscription/status", {
  success: OperationResponse(SubscriptionStatus),
  error: Unavailable,
})
  .annotate(
    OpenApi.Description,
    "Check your current trial and paid Subscription periods, AccessTier, and recent BillingAttempts. Use it to explain current access without treating exhausted allowances as a Paywall."
  )
  .annotateMerge(
    operationPolicy({
      access: patScoped("read"),
      requiredTier: "free",
      agentConfirmation: "not-required",
      kind: "query",
    })
  );

/** Canonical Free operation group for discovering and presenting Subscription standing and offers. */
export const SubscriptionGroup = HttpApiGroup.make("subscription")
  .add(getUpgradeUrl)
  .add(listSubscriptionOffers)
  .add(getSubscriptionStatus);
