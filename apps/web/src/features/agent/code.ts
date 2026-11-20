export const preloadAgentConversation = (): Promise<void> =>
  Promise.all([
    import("./feature").then((module) => module.HostedAgentFeature.preloadInteractions()),
    import("./content"),
  ]).then(() => undefined);
