import { HttpApiBuilder } from "effect/unstable/httpapi";
import { FidyApi } from "~/shell/api";
import { getUpgradeUrl } from "./queries";

/** Binds the Subscription operation group to the configured public-web upgrade destination. */
export const SubscriptionLive = HttpApiBuilder.group(FidyApi, "subscription", (handlers) =>
  handlers.handle("getUpgradeUrl", () => getUpgradeUrl())
);
