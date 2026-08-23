import { Effect } from "effect";
import { UpgradeDestination } from "~/core/subscription/model";
import { externalEndpoints } from "~/shell/_shared/external-endpoints";
import { selectSubscriptionOffers } from "./repo";

/** Reads the configured upgrade destination. Misconfiguration is a defect, not a caller failure. */
export const getUpgradeUrl = Effect.fn("getUpgradeUrl")(function* () {
  const { upgradeUrl } = yield* externalEndpoints.pipe(Effect.orDie);
  return { data: UpgradeDestination.make({ url: new URL(upgradeUrl) }), next: [] };
});

/** Reads the exact immutable Subscription offer set every Colombia caller shares. */
export const listSubscriptionOffers = Effect.fn("listSubscriptionOffers")(function* () {
  return { data: yield* selectSubscriptionOffers, next: [] };
});
