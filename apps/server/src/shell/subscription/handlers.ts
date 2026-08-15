import { Effect } from "effect";
import { HttpApiBuilder } from "effect/unstable/httpapi";
import { UpgradeDestination } from "~/core/subscription/model";
import { externalEndpoints } from "~/shell/_shared/external-endpoints";
import { FidyApi } from "~/shell/api";

/** Binds the Subscription operation group to the configured public-web upgrade destination. */
export const SubscriptionLive = HttpApiBuilder.group(FidyApi, "subscription", (handlers) =>
  handlers.handle("getUpgradeUrl", () =>
    Effect.gen(function* () {
      const { upgradeUrl } = yield* externalEndpoints.pipe(Effect.orDie);
      return {
        data: UpgradeDestination.make({ url: new URL(upgradeUrl) }),
        next: [],
      };
    })
  )
);
