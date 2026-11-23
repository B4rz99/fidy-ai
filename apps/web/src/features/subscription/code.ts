import { lazyRouteComponent } from "@tanstack/react-router";

const SubscriptionOffersFeature = lazyRouteComponent(
  () => import("./feature"),
  "SubscriptionOffersFeature"
);

const SubscriptionOffersPreview = lazyRouteComponent(
  () => import("./dev-preview"),
  "SubscriptionDataPreview"
);

export const SubscriptionOffersRoute = import.meta.env.DEV
  ? SubscriptionOffersPreview
  : SubscriptionOffersFeature;

export const preloadSubscriptionScreen = (): Promise<void> =>
  Promise.all([
    import("./feature").then((module) => module.SubscriptionOffersFeature.preloadInteractions()),
    import("./payment-details"),
  ]).then(() => undefined);
