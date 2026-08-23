import { HttpApiBuilder } from "effect/unstable/httpapi";
import { FidyApi } from "~/shell/api";
import { getUpgradeUrl, listSubscriptionOffers } from "./queries";

/** Authenticated Subscription discovery and offer-presentation API group. */
export const SubscriptionLive = HttpApiBuilder.group(FidyApi, "subscription", (handlers) =>
  handlers
    .handle("getUpgradeUrl", () => getUpgradeUrl())
    .handle("listSubscriptionOffers", () => listSubscriptionOffers())
);
