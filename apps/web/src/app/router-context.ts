import type { AtomRegistry } from "effect/reactivity";
import type { FidyClient, HostedTurnClient, WebAuthClient } from "@/transport/client";

export type WebRouterContext = Readonly<{
  registry: AtomRegistry.AtomRegistry;
  /** Display identity checked by BrowserSessionBoundary; never grants authority. */
  sessionBinding: string;
  browserRequestsIdle: () => boolean;
  apiClient: FidyClient;
  webAuthClient: WebAuthClient;
  hostedTurnClient: HostedTurnClient;
}>;
