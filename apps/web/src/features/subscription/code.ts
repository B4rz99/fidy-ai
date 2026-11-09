export const preloadSubscriptionScreen = (): Promise<void> =>
  Promise.all([
    import("./feature").then((module) => module.SubscriptionOffersFeature.preloadInteractions()),
    import("./payment-details"),
  ]).then(() => undefined);
